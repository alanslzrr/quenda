# One Quenda host on Azure: a resource group with a VNet, a network security
# group open on 80/443 and on SSH from one CIDR, a static public IP and a VM.

module "host" {
  source       = "../modules/cloud-init"
  domain       = var.domain
  acme_email   = var.acme_email
  email_locale = var.email_locale
  smtp         = var.smtp
}

resource "azurerm_resource_group" "quenda" {
  name     = var.name
  location = var.location
}

resource "azurerm_virtual_network" "quenda" {
  name                = var.name
  resource_group_name = azurerm_resource_group.quenda.name
  location            = azurerm_resource_group.quenda.location
  address_space       = ["10.20.0.0/16"]
}

resource "azurerm_subnet" "public" {
  name                 = "public"
  resource_group_name  = azurerm_resource_group.quenda.name
  virtual_network_name = azurerm_virtual_network.quenda.name
  address_prefixes     = ["10.20.1.0/24"]
}

resource "azurerm_network_security_group" "host" {
  name                = var.name
  resource_group_name = azurerm_resource_group.quenda.name
  location            = azurerm_resource_group.quenda.location

  security_rule {
    name                       = "ssh"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = var.ssh_source_cidr
    destination_address_prefix = "*"
  }
  security_rule {
    name                       = "web"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_ranges    = ["80", "443"]
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
  security_rule {
    name                       = "http3"
    priority                   = 120
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Udp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "public" {
  subnet_id                 = azurerm_subnet.public.id
  network_security_group_id = azurerm_network_security_group.host.id
}

resource "azurerm_public_ip" "quenda" {
  name                = var.name
  resource_group_name = azurerm_resource_group.quenda.name
  location            = azurerm_resource_group.quenda.location
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_network_interface" "quenda" {
  name                = var.name
  resource_group_name = azurerm_resource_group.quenda.name
  location            = azurerm_resource_group.quenda.location

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.public.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.quenda.id
  }
}

resource "azurerm_linux_virtual_machine" "quenda" {
  name                  = var.name
  resource_group_name   = azurerm_resource_group.quenda.name
  location              = azurerm_resource_group.quenda.location
  size                  = var.size
  admin_username        = "ubuntu"
  network_interface_ids = [azurerm_network_interface.quenda.id]
  custom_data           = base64encode(module.host.user_data)

  admin_ssh_key {
    username   = "ubuntu"
    public_key = var.ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = var.disk_size_gb
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = var.architecture == "arm64" ? "server-arm64" : "server"
    version   = "latest"
  }

  # The OS disk holds the database: edited first-boot settings must never
  # replace the VM. Change settings with `quenda` on the host.
  lifecycle {
    ignore_changes = [custom_data]
  }
}
