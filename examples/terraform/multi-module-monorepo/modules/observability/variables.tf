variable "name" {
  type = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "monitored_resource_id" {
  type        = string
  description = "The resource whose diagnostics are shipped to this workspace."
}

variable "tags" {
  type    = map(string)
  default = {}
}
