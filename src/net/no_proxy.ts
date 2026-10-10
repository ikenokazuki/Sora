// NO_PROXY / no_proxy の判定。静的fetch（wreq）がブラウザと同じ除外リストを守るために使う。
// 対応する書き方: "*"（すべて）、ホスト名（"example.com" はサブドメインも含む。先頭の "." や "*." も可）、
// IP アドレス、IPv4 の CIDR（"10.0.0.0/8"）。エントリのポート指定は無視する。

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const v = Number(p);
    if (v > 255) return undefined;
    n = n * 256 + v;
  }
  return n;
}

function matchesEntry(host: string, rawEntry: string): boolean {
  let entry = rawEntry.trim().toLowerCase();
  if (!entry) return false;
  if (entry === '*') return true;
  if (entry.startsWith('[')) entry = entry.slice(1, entry.indexOf(']') > 0 ? entry.indexOf(']') : undefined);
  else if ((entry.match(/:/g) ?? []).length === 1) entry = entry.split(':')[0];

  const cidr = entry.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (cidr) {
    const hostInt = ipv4ToInt(host);
    const base = ipv4ToInt(cidr[1]);
    const bits = Number(cidr[2]);
    if (hostInt === undefined || base === undefined || bits > 32) return false;
    const block = 2 ** (32 - bits);
    return Math.floor(hostInt / block) === Math.floor(base / block);
  }

  const domain = entry.replace(/^\*?\./, '');
  return host === domain || host.endsWith(`.${domain}`);
}

/** ホストが除外リストに当たるか（当たればプロキシを使わない）。 */
export function isProxyBypassed(hostname: string, bypassList: string | undefined): boolean {
  if (!bypassList) return false;
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return false;
  return bypassList.split(',').some((entry) => matchesEntry(host, entry));
}
