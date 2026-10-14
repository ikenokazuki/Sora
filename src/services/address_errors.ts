/** 住所機能の例外。REST と MCP でのエラーの種類をここで決める。 */

/** 入力の誤り（REST では INVALID_INPUT / 400）。 */
export class AddressInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddressInputError';
  }
}

/** SORA_ADDRESS=off で無効化されている（REST では ADDRESS_DISABLED / 404）。 */
export class AddressDisabledError extends Error {
  constructor() {
    super('住所機能は SORA_ADDRESS=off で無効化されています');
    this.name = 'AddressDisabledError';
  }
}

/** 必要なデータを取得できない（国外からの接続拒否、通信失敗、取得元の形式変更）。REST では ADDRESS_DATA_UNAVAILABLE / 502。 */
export class AddressUnavailableError extends Error {
  /** artifact は失敗したデータの ID（`master` / `postal` / `city:<lg_code>`）。 */
  constructor(message: string, readonly blocked = false, readonly artifact?: string) {
    super(message);
    this.name = 'AddressUnavailableError';
  }
}

/**
 * 待ち時間の上限までにデータが揃わなかった。呼び出し側は取れている範囲で答える。
 * 答えようがない場合（全国マスターや郵便番号が揃わない）の REST は ADDRESS_DATA_PENDING / 502（再試行できる）。
 */
export class AddressPendingError extends Error {
  constructor(readonly pending: string) {
    super(`address data pending: ${pending}`);
    this.name = 'AddressPendingError';
  }
}

/** 利用者（MCP の呼び出し元・REST の利用者）に見せるエラー文。待ち時間切れは、構築が裏で続いているので再実行すれば答えられると添える。 */
export function addressErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof AddressPendingError ? `${message}（データを取得中です。しばらくして再実行してください）` : message;
}
