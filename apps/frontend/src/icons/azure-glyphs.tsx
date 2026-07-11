/**
 * Blueprint resource glyphs (GP-29). Original, line-style SVG glyphs for the
 * common Azure service families, authored in-repo to a 24×24 grid so they sit
 * cleanly next to the lucide category icons. Rendered with `stroke:currentColor`
 * so they tint with the node's category colour (a deliberate blueprint choice —
 * see ICONS.md; swapping in Microsoft's official coloured set is a drop-in).
 *
 * This is the "sprite" the ticket asks for: path data inlined in one module,
 * tree-shaken and a few KB total (well under the 150KB budget) — no per-file
 * asset requests, no bundler config.
 */
import type { ReactElement } from "react";

export type AzureGlyphKey =
  | "virtual-machine"
  | "vmss"
  | "vnet"
  | "subnet"
  | "nsg"
  | "load-balancer"
  | "app-gateway"
  | "kubernetes"
  | "container-registry"
  | "key-vault"
  | "storage"
  | "database"
  | "cosmos-db"
  | "redis"
  | "dns"
  | "monitor"
  | "app-service"
  | "identity"
  | "public-ip"
  | "nic"
  | "resource-group"
  | "firewall"
  | "route-table"
  | "cube";

export const AZURE_GLYPHS: Record<AzureGlyphKey, ReactElement> = {
  "virtual-machine": (
    <>
      <rect x="2.5" y="4.5" width="19" height="12" rx="1.5" />
      <path d="M6 8.5h7" />
      <path d="M8.5 20h7M12 16.5V20" />
    </>
  ),
  vmss: (
    <>
      <rect x="7.5" y="3.5" width="13" height="8" rx="1" />
      <path d="M4.5 7.5v9A1.5 1.5 0 0 0 6 18h11" />
      <path d="M11 6.5h6" />
    </>
  ),
  vnet: (
    <>
      <circle cx="5.5" cy="6" r="2" />
      <circle cx="18.5" cy="6" r="2" />
      <circle cx="12" cy="18" r="2" />
      <path d="M7 6h10M6.7 7.7l4.4 8.6M17.3 7.7l-4.4 8.6" />
    </>
  ),
  subnet: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <rect x="7.5" y="8.5" width="9" height="7" rx="1" strokeDasharray="2 2" />
    </>
  ),
  nsg: (
    <>
      <path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z" />
      <path d="M9 11.8l2 2 4-4" />
    </>
  ),
  "load-balancer": (
    <>
      <circle cx="12" cy="5" r="2" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="12" cy="19" r="2" />
      <circle cx="19" cy="19" r="2" />
      <path d="M12 7v3M5 17v-2.5h14V17M12 14.5V17" />
    </>
  ),
  "app-gateway": (
    <>
      <rect x="4.5" y="4.5" width="15" height="15" rx="1.5" />
      <path d="M8.5 12h6M12 9.5 14.5 12 12 14.5" />
    </>
  ),
  kubernetes: (
    <>
      <path d="M12 3l7.5 4.3v8.6L12 20l-7.5-4.1V7.3z" />
      <circle cx="12" cy="11.6" r="2.1" />
      <path d="M12 5.6v3.9M12 13.7v4.2M6.9 8.8l3.3 1.9M17.1 8.8l-3.3 1.9" />
    </>
  ),
  "container-registry": (
    <>
      <path d="M6 9.5 12 5l6 4.5" />
      <rect x="4.5" y="9.5" width="15" height="9.5" rx="1" />
      <path d="M9 9.5v9.5M13.5 9.5v9.5M4.5 14h15" />
    </>
  ),
  "key-vault": (
    <>
      <circle cx="8.5" cy="8.5" r="3.5" />
      <path d="M10.9 11 20 20M16.5 16.5 18.5 14.5M18 18l1.7-1.7" />
    </>
  ),
  storage: (
    <>
      <rect x="3" y="7" width="18" height="10" rx="2" />
      <path d="M6 12h7" />
      <circle cx="17" cy="12" r="1.3" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="2.7" />
      <path d="M5 6v12c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7V6" />
      <path d="M5 12c0 1.5 3.1 2.7 7 2.7s7-1.2 7-2.7" />
    </>
  ),
  "cosmos-db": (
    <>
      <circle cx="12" cy="12" r="2" />
      <ellipse cx="12" cy="12" rx="9" ry="3.8" />
      <ellipse cx="12" cy="12" rx="9" ry="3.8" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="9" ry="3.8" transform="rotate(120 12 12)" />
    </>
  ),
  redis: <path d="M12.5 3 5 13h5l-1.5 8 8-11h-5z" />,
  dns: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16M12 4c2.8 2.1 2.8 13.9 0 16M12 4c-2.8 2.1-2.8 13.9 0 16" />
    </>
  ),
  monitor: <path d="M3 12.5h4l2.5-7 4 13 2.5-6h5" />,
  "app-service": (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="M3.5 9h17" />
      <path d="M6 6.7h.01M8.5 6.7h.01" />
      <circle cx="12" cy="14" r="3" />
      <path d="M9 14h6M12 11c1.4 1.1 1.4 4.9 0 6" />
    </>
  ),
  identity: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.7 19c0-3 2.4-5 5.3-5 .9 0 1.8.2 2.6.6" />
      <circle cx="16.5" cy="15" r="2" />
      <path d="M17.9 16.4 20.5 19M18.7 17.8 20 16.5" />
    </>
  ),
  "public-ip": (
    <>
      <path d="M4 6.5v6.4l7.6 7.6 6.9-6.9L11 6H6a2 2 0 0 0-2 .5z" />
      <circle cx="8.2" cy="10.3" r="1.3" />
    </>
  ),
  nic: (
    <>
      <rect x="3.5" y="7" width="17" height="10" rx="1.5" />
      <path d="M7 17v2M11 17v2M15 17v2M7 11h4" />
    </>
  ),
  "resource-group": (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" strokeDasharray="3 2.5" />
      <rect x="7" y="8" width="4" height="4" rx=".5" />
      <rect x="13" y="12" width="4" height="4" rx=".5" />
    </>
  ),
  firewall: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1" />
      <path d="M3.5 10h17M3.5 14.5h17M9 5.5V10M15 5.5V10M12 10v4.5M9 14.5V18.5M15 14.5V18.5" />
    </>
  ),
  "route-table": (
    <>
      <path d="M6.5 20c0-5 11-4.5 11-10 0-2.6-2.4-4-4.5-4" />
      <circle cx="6.5" cy="20" r="1.7" />
      <circle cx="13" cy="6" r="1.7" />
    </>
  ),
  cube: (
    <>
      <path d="M12 3 4.5 7v10L12 21l7.5-4V7z" />
      <path d="M4.7 7.1 12 11l7.3-3.9M12 11v10" />
    </>
  ),
};
