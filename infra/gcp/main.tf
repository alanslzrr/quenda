# One Quenda host on GCP: a custom VPC with one subnetwork, firewall rules for
# 80/443 and for SSH from one CIDR, a static external IP and a VM.

module "host" {
  source       = "../modules/cloud-init"
  domain       = var.domain
  acme_email   = var.acme_email
  email_locale = var.email_locale
  smtp         = var.smtp
}

resource "google_compute_network" "quenda" {
  name                    = var.name
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "public" {
  name          = "${var.name}-public"
  network       = google_compute_network.quenda.id
  region        = var.region
  ip_cidr_range = "10.20.1.0/24"
}

resource "google_compute_firewall" "ssh" {
  name          = "${var.name}-ssh"
  network       = google_compute_network.quenda.id
  direction     = "INGRESS"
  source_ranges = [var.ssh_source_cidr]
  target_tags   = [var.name]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_compute_firewall" "web" {
  name          = "${var.name}-web"
  network       = google_compute_network.quenda.id
  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = [var.name]
  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
  allow {
    protocol = "udp"
    ports    = ["443"]
  }
}

resource "google_compute_address" "quenda" {
  name   = var.name
  region = var.region
}

resource "google_compute_instance" "quenda" {
  name         = var.name
  machine_type = var.machine_type
  zone         = var.zone
  tags         = [var.name]

  boot_disk {
    initialize_params {
      image = var.image
      size  = var.disk_size_gb
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.public.id
    access_config {
      nat_ip = google_compute_address.quenda.address
    }
  }

  metadata = {
    ssh-keys       = "ubuntu:${var.ssh_public_key}"
    user-data      = module.host.user_data
    enable-oslogin = "FALSE"
  }

  shielded_instance_config {
    enable_secure_boot = true
  }

  # The boot disk holds the database: a newer image or edited first-boot
  # settings must never replace the VM. Change settings with `quenda` on the host.
  lifecycle {
    ignore_changes = [boot_disk[0].initialize_params[0].image, metadata["user-data"]]
  }
}
