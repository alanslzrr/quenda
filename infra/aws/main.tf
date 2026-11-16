# One Quenda host on AWS: a VPC with one public subnet, a security group open
# on 80/443 and on SSH from one CIDR, an EC2 instance and a fixed Elastic IP.

module "host" {
  source       = "../modules/cloud-init"
  domain       = var.domain
  acme_email   = var.acme_email
  email_locale = var.email_locale
  smtp         = var.smtp
}

data "aws_availability_zones" "available" {
  state = "available"
}

# Latest Canonical Ubuntu 24.04 for the instance architecture, unless pinned.
data "aws_ami" "ubuntu" {
  count       = var.ami_id == "" ? 1 : 0
  owners      = ["099720109477"]
  most_recent = true
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-${var.architecture}-server-*"]
  }
}

resource "aws_vpc" "quenda" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_internet_gateway" "quenda" {
  vpc_id = aws_vpc.quenda.id
  tags   = { Name = var.name }
}

resource "aws_subnet" "public" {
  vpc_id            = aws_vpc.quenda.id
  cidr_block        = "10.20.1.0/24"
  availability_zone = data.aws_availability_zones.available.names[0]
  tags              = { Name = "${var.name}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.quenda.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.quenda.id
  }
  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "host" {
  name        = var.name
  description = "Quenda host: web from anywhere, SSH from operators"
  vpc_id      = aws_vpc.quenda.id
  tags        = { Name = var.name }
}

resource "aws_vpc_security_group_ingress_rule" "web" {
  for_each          = { http = ["tcp", 80], https = ["tcp", 443], http3 = ["udp", 443] }
  security_group_id = aws_security_group.host.id
  description       = upper(each.key)
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = each.value[0]
  from_port         = each.value[1]
  to_port           = each.value[1]
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  security_group_id = aws_security_group.host.id
  description       = "SSH for operators"
  cidr_ipv4         = var.ssh_source_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.host.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_key_pair" "operator" {
  key_name   = var.name
  public_key = var.ssh_public_key
}

resource "aws_instance" "quenda" {
  ami                    = var.ami_id != "" ? var.ami_id : data.aws_ami.ubuntu[0].id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  availability_zone      = aws_subnet.public.availability_zone
  vpc_security_group_ids = [aws_security_group.host.id]
  key_name               = aws_key_pair.operator.key_name
  user_data              = module.host.user_data

  root_block_device {
    volume_type = "gp3"
    volume_size = var.volume_size_gb
    encrypted   = true
  }

  metadata_options {
    http_tokens = "required"
  }

  tags = { Name = var.name }

  # The root volume holds the database: a newer AMI or edited first-boot
  # settings must never replace the instance.
  lifecycle {
    ignore_changes = [ami, user_data]
  }
}

resource "aws_eip" "quenda" {
  instance = aws_instance.quenda.id
  domain   = "vpc"
  tags     = { Name = var.name }
}
