# The emulator writes its endpoint (https://127.0.0.1:9297), CA bundle and
# generated credentials into an AWS shared config, mounted at the same path it has in the emulator.
provider "aws" {
  shared_config_files      = ["/home/emulator/.aws/emulator/9297/config"]
  shared_credentials_files = ["/home/emulator/.aws/emulator/9297/emulator_credentials"]
  profile                  = "default"
}

# aws-emulator does not create the default egress rule of a new security group,
# so the provider's revocation of that rule fails (issue
# ec2-revokesecuritygroupegress in aws/aws-emulator). The security group is
# planned but not applied; the instance is applied without it.
resource "aws_instance" "quenda" {
  vpc_security_group_ids = null
}

# The emulator has no Canonical AMIs; the lookup runs against an Amazon-owned one.
data "aws_ami" "ubuntu" {
  owners = ["amazon"]
  filter {
    name   = "architecture"
    values = ["arm64"]
  }
}
