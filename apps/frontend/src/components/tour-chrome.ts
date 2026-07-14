/**
 * GP-79: what a tour chrome is handed.
 *
 * The engine (`tour/use-tour.ts`) decides which stop we are on; a chrome decides
 * what that looks like. This type is the whole contract between them, and it is
 * deliberately tiny — a chrome cannot advance the tour by any means other than
 * calling `onNext`, and it knows nothing about snapshots, the API, or the camera.
 *
 * Two chromes implement it today (`TourSpotlight`, `TourRail`), chosen by a user
 * preference. A third would need nothing from either of them.
 */
import type { TourStep } from "@/api/types";

export type TourChrome = {
  step: TourStep;
  index: number;
  total: number;
  /** The model that wrote the tour. A chrome must say so; the reader should know. */
  model: string | null;
  onNext: () => void;
  onPrev: () => void;
  onExit: () => void;
};
