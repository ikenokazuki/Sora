import { incrementSecurityCounter } from '../security/metrics.js';
import type { DenyReason } from './egress_gateway.js';
import { isBlockedHostname, isPrivateIp } from './ip_policy.js';

/**
 * URL の事前検査（取得の前に、内部・遮断する宛先を断る検査）が断った理由。出口のゲートウェイの `DenyReason` の部分集合で、
 * 同じ名前を使う: ゲートウェイは `sora_egress_denied_<理由>_total`、事前検査は `sora_precheck_denied_<理由>_total`
 */
export type PrecheckReason = Extract<DenyReason, 'private_ip' | 'blocked_host' | 'dns'>;

/** 内部・遮断する宛先の理由。IP が先、次に名前（ゲートウェイと同じ見分け方）。通す宛先は undefined */
export function hostDenyReason(host: string): 'private_ip' | 'blocked_host' | undefined {
  if (isPrivateIp(host)) return 'private_ip';
  return isBlockedHostname(host) ? 'blocked_host' : undefined;
}

/** 事前検査が断った回数を数える（断った 1 回につき 1 つ） */
export function countPrecheckDenied(reason: PrecheckReason): void {
  incrementSecurityCounter(`sora_precheck_denied_${reason}_total`);
}

/** 内部・遮断する宛先なら、断った回数を数えて true。通す宛先は false（数えない） */
export function deniesHost(host: string): boolean {
  const reason = hostDenyReason(host);
  if (reason) countPrecheckDenied(reason);
  return reason !== undefined;
}
