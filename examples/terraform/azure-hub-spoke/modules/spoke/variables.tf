variable "name" {
  type        = string
  description = "Short spoke name, used as the suffix of every resource."
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "address_space" {
  type        = string
  description = "The spoke's /16."
}

variable "ssh_public_key" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
