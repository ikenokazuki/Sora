# audio-signature

16 kHz・モノラルの PCM（Int16）から、楽曲認識に使う音の指紋（SigX の形のバイト列）を作り、その形を確かめます。ブラウザ・Bun・Node で動きます（依存なし、ESM）。

```sh
npm install audio-signature
```

```ts
import { checkSignatureBase64, createSignature, encodeBase64 } from 'audio-signature';

const { bytes, sampleMs } = createSignature(pcm); // pcm: 16 kHz・モノラルの Int16Array。先頭の 12 秒だけを使う
const signature = encodeBase64(bytes);
checkSignatureBase64(signature, sampleMs); // true
```

| export | 内容 |
|---|---|
| `SAMPLE_RATE` (16000)・`WINDOW_SECONDS` (12)・`MIN_WINDOW_SECONDS` (3) | 入力の決まり |
| `createSignature(pcm)` | `{ bytes, sampleMs }`。3 秒未満・ピークが無い（静かすぎる）音は `SignatureTooShortError` |
| `checkSignature(bytes, sampleMs)` | 長さ 56 以上・magic `0xCAFE2580`・CRC-32・大きさの欄・ヘッダーのサンプル数と `sampleMs` の一致（ピークの値は見ない） |
| `checkSignatureBase64(signature, sampleMs)` | base64 として読め、正規の base64 に戻り、`checkSignature` を満たすか |
| `encodeBase64`・`decodeBase64`・`crc32` | 補助（`decodeBase64` は読めない文字列で `null`） |
| `SignatureGenerator`・`powerSpectrum` | 計算の部品 |

同じ PCM からは、Sora（Bun）と同じバイト列になることを黄金値のテストで確かめています。JavaScript エンジンによってピークの値がわずかに変わることがあるため、`checkSignature` はピークの値を見ません。

## ライセンス

MIT（[LICENSE](./LICENSE)）。計算は omkarcloud の `sigx.py`（MIT、Copyright (c) 2026 Chetan Jain）の TypeScript への移植です。ソースは [ikenokazuki/Sora](https://github.com/ikenokazuki/Sora) の `packages/audio-signature/` にあります。
