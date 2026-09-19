/**
 * Tracking Service (v2 compatibility layer)
 * 
 * Sora v2.25.0 より、Tracking 内部アーキテクチャは
 * src/services/tracking/ (Carrier Adapter + Ranked Detection + Bounded Verification)
 * へ刷新されました。
 * 本ファイルは後方互換性のための薄い再エクスポート層を提供します。
 */

import type { CarrierCode, TrackingResult } from '../types.js';
import {
  cleanTrackingNumber,
  getCarrierTrackingUrl,
  getCarrierName,
  trackByCarrier,
  trackPackageAuto,
  trackPackage,
  TRACKING_CACHE_TTL,
  TRACKING_DELIVERED_CACHE_TTL,
} from './tracking/index.js';
import { determineStatus as yamatoDetermineStatus } from './tracking/carriers/yamato.js';

export * from './tracking/index.js';

export const determineStatus = yamatoDetermineStatus;

export async function trackYamato(trackingNumber: string): Promise<TrackingResult> {
  return trackByCarrier('yamato', trackingNumber);
}

export async function trackSagawa(trackingNumber: string): Promise<TrackingResult> {
  return trackByCarrier('sagawa', trackingNumber);
}

export async function trackJapanPost(trackingNumber: string): Promise<TrackingResult> {
  return trackByCarrier('japanpost', trackingNumber);
}

export async function trackSeino(trackingNumber: string): Promise<TrackingResult> {
  return trackByCarrier('seino', trackingNumber);
}

export async function trackFukutsu(trackingNumber: string): Promise<TrackingResult> {
  return trackByCarrier('fukutsu', trackingNumber);
}

export async function trackUps(trackingNumber: string): Promise<TrackingResult> {
  return trackByCarrier('ups', trackingNumber);
}

export async function trackFedEx(trackingNumber: string): Promise<TrackingResult> {
  return trackByCarrier('fedex', trackingNumber);
}

export async function trackDhl(trackingNumber: string): Promise<TrackingResult> {
  return trackByCarrier('dhl', trackingNumber);
}
