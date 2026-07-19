/**
 * Hub-edge taming config (GP-35), all in one place per the ticket. A node is a
 * "hub" when its dependency degree exceeds the threshold, OR its resource type
 * is a known fan-out type (resource groups, identity/config data sources) that
 * everything wires to. Hub edges are hidden by default to kill the edge wall.
 */

/** A node with more than this many depends_on edges (in + out) is a hub. */
export const HUB_DEGREE_THRESHOLD = 15;

/** Resource types that are hubs regardless of degree (fan-out by nature). */
export const HUB_TYPES: ReadonlySet<string> = new Set<string>([
  "azurerm_resource_group",
  "azurerm_client_config",
  "azurerm_subscription",
  "aws_caller_identity",
  "aws_region",
  "aws_availability_zones",
  "google_client_config",
  "google_project",
]);
