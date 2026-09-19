import type {
  CarrierCode,
  TrackingResolvedCarrier,
  TrackingStatus,
  TrackingEvent,
  TrackingResult,
  TrackingRequest,
} from '../../types.js';

export type {
  CarrierCode,
  TrackingResolvedCarrier,
  TrackingStatus,
  TrackingEvent,
  TrackingResult,
  TrackingRequest,
};

export interface TrackingDetectionHints {
  preferredCarriers?: CarrierCode[];
  originCountry?: string;
  destinationCountry?: string;
}

export interface CarrierDetectionSignal {
  candidate: boolean;
  score: number; // ranking用。確率ではない
  strength: 'exclusive' | 'strong' | 'weak';
  reasons: string[];
}

export interface TrackingVerification {
  level: 'strong' | 'weak' | 'none';
  reasons: string[];
}

export interface TrackingContext {
  signal?: AbortSignal;
  noCache?: boolean;
}

export interface TrackingCarrierAdapter {
  code: CarrierCode;
  name: string;

  detect(
    trackingNumber: string,
    hints?: TrackingDetectionHints,
  ): CarrierDetectionSignal;

  track(
    trackingNumber: string,
    context?: TrackingContext,
  ): Promise<TrackingResult>;

  verify(
    result: TrackingResult,
    requestedTrackingNumber: string,
  ): TrackingVerification;

  trackingUrl(
    trackingNumber: string,
  ): string;
}

export interface S10ParseResult {
  valid: boolean;
  serviceIndicator: string;
  serialNumber: string;
  checkDigit: number;
  issuingCountry: string;
  reasons: string[];
}
