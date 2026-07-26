variable "name" {
  type = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "app_subnet_id" {
  type = string
}

variable "data_subnet_id" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
