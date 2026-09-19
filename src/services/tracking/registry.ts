import type { CarrierCode } from '../../types';
import type { TrackingCarrierAdapter } from './types';
import { yamatoAdapter } from './carriers/yamato';
import { sagawaAdapter } from './carriers/sagawa';
import { japanpostAdapter } from './carriers/japanpost';
import { seinoAdapter } from './carriers/seino';
import { fukutsuAdapter } from './carriers/fukutsu';
import { upsAdapter } from './carriers/ups';
import { fedexAdapter } from './carriers/fedex';
import { dhlAdapter } from './carriers/dhl';

export const ALL_CARRIER_ADAPTERS: TrackingCarrierAdapter[] = [
  yamatoAdapter,
  sagawaAdapter,
  japanpostAdapter,
  seinoAdapter,
  fukutsuAdapter,
  upsAdapter,
  fedexAdapter,
  dhlAdapter,
];

const adapterMap = new Map<CarrierCode, TrackingCarrierAdapter>(
  ALL_CARRIER_ADAPTERS.map((adapter) => [adapter.code, adapter])
);

export function getCarrierAdapter(carrier: CarrierCode): TrackingCarrierAdapter | undefined {
  return adapterMap.get(carrier);
}

export function getAllCarrierAdapters(): TrackingCarrierAdapter[] {
  return ALL_CARRIER_ADAPTERS;
}

export function getCarrierName(carrier: CarrierCode): string {
  const adapter = getCarrierAdapter(carrier);
  return adapter ? adapter.name : carrier;
}

export function getCarrierTrackingUrl(carrier: CarrierCode, trackingNumber: string): string {
  const adapter = getCarrierAdapter(carrier);
  if (adapter) {
    return adapter.trackingUrl(trackingNumber);
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trackingNumber)}`;
}
