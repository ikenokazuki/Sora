/**
 * Markdown 本文の節への切り分けと、問いから語を選ぶ処理。
 * 段落の点数（hierarchical_bm25 の scorePassage）とハイライト（enrichment の extractQueryHighlightDetails）、
 * X の投稿の要件の確かめ（services/x_detail）が使う。もとは rho-select（廃止）の一部。
 */

const NAV_LABEL_MAX_CHARS = 16;

/**
 * 行が「テキストラベルだけのリンク」か。リンクの判別は最後の `](URL)` で行う（画像リンク全体も1つのリンク）。
 * ラベルがテキストなら返し、画像だけ `[![alt](src)](url)`（SNS アイコン・バナー等）や空のラベルなら、
 * 「リンク行だがナビの候補ではない」として null を返す。リンクですらない行は undefined。
 */
type LabelLinkVerdict = { label: string } | null | undefined;
function isLabelLinkLine(line: string): LabelLinkVerdict {
  const trimmed = line.trim();
  const last = trimmed.lastIndexOf('](');
  if (last < 0 || !trimmed.endsWith(')')) return undefined;
  const before = trimmed.slice(0, last);
  // 先頭のリスト記号と `[` を外す。外側の `[...](...)` が閉じていなければリンク行ではない:
  // 行全体が 1 つのリンクとして読めるのは、最後の `](` の後ろの最初の `)` が行の末尾のとき（行は改行を含まない）。
  // 正規表現 /^[-*+\d.\s]*\[([\s\S]*)\]\([^)\n]*\)$/ と同じ判定だが、正規表現は `](` の多い行で長さの二乗の時間がかかった
  const stripped = before.replace(/^[-*+\d.\s]*\[/, '');
  if (stripped === before || trimmed.indexOf(')', last + 2) !== trimmed.length - 1) return undefined;
  const label = stripped.trim();
  if (!label || label === '-') return null;
  if (label.startsWith('!')) return null;
  return { label };
}

/** 塊がすべて「[短いラベル](URL)」行か（グローバルナビ・パンくず・フッターのリンク列）。
 * 空のラベル行（取り除けなかった SNS アイコン列など）は無視する。画像だけのリンク行がある塊は動かさない
 * （別の塊にまとめられる。削除されることはないので害はない）。 */
export function isNavBlock(block: string): boolean {
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
  // 空のリスト記号だけの行（`-` のみ）は、Turndown が空のリンクや画像を取り除いた残骸なので無視する
  const labels = lines.filter((l) => !/^[-*+]\s*$/.test(l)).map((l) => isLabelLinkLine(l));
  // 全行がリンク行で、かつテキストラベルが1つ以上ある塊をナビとして扱う。
  // 画像だけの行（バナー・SNS アイコン）はテキストラベルとみなさないが、ナビ扱いも妨げない
  // （グローバルナビの途中に SNS アイコンが混じる equal-love.jp のような実データに対応）。
  return labels.every((l) => l !== undefined) && labels.some((l) => l !== null && l.label.length <= NAV_LABEL_MAX_CHARS);
}

export interface ParsedSection {
  rawHeading: string;
  heading: string;
  headingLevel: number;
  paragraphs: string[];
  fullText: string;
  charLength: number;
  startIndex: number;
}

/**
 * 空行で区切った段落のうち、短いラベルのリンクだけの段落（2 行以上。グローバルナビ・言語の一覧など）を外す。
 * 1 行だけのリンク（「申し込み」など）は外さない。コードブロックの中は区切らない。
 */
function dropNavParagraphs(lines: string[]): string[] {
  const out: string[] = [];
  let block: string[] = [];
  let inCode = false;
  const end = () => {
    const nonEmpty = block.filter((l) => l.trim() !== '').length;
    if (block.length > 0 && !(nonEmpty >= 2 && isNavBlock(block.join('\n')))) out.push(...block);
    block = [];
  };
  for (const line of lines) {
    if (line.trim().startsWith('```')) inCode = !inCode;
    if (!inCode && line.trim() === '') {
      end();
      out.push(line);
    } else {
      block.push(line);
    }
  }
  end();
  return out;
}

/**
 * Markdown 本文を見出し (H1〜H6) 単位でセクションに分割
 * コードブロック (```) 内の見出し記号 (#) を安全に保護
 */
export function parseMarkdownSections(markdown: string): ParsedSection[] {
  if (!markdown) return [];

  // 1. YAML Frontmatter (--- ... ---) を本文ハイライト候補から除外
  let cleaned = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, '');
  // 2. システム付与のパンくず・イベント階層行 (> 📍 **階層**: ... 等) からルートタイトルを抽出
  let rootContext = '';
  const breadcrumbMatch = cleaned.match(/^>\s*📍\s*\*\*階層\*\*:\s*(?:.*?[>›\\]\s*)*([^\r\n>›\\]+)$/m);
  if (breadcrumbMatch) {
    rootContext = breadcrumbMatch[1].trim();
  }
  cleaned = cleaned.replace(/^>\s*(?:📍|📅)\s*\*\*.*?\*\*:.*$/gm, '');

  const lines = cleaned.split(/\r?\n/);
  const sections: ParsedSection[] = [];
  let currentHeading = '';
  let currentRawHeading = '';
  let currentLevel = 0;
  let currentParagraphs: string[] = [];
  let inCodeBlock = false;
  let sectionStartIndex = 0;
  let runningIndex = 0;
  const headingStack: { level: number; heading: string }[] = [];

  const flush = () => {
    // 節の中の、短いラベルのリンクだけの段落は、ハイライトの候補にも書き出しにもしない
    const keptLines = dropNavParagraphs(currentParagraphs);
    const fullText = keptLines.join('\n').trim();
    if (fullText.length > 0) {
      // プリアンブル（見出し未設定の先頭テキスト）のノイズ判定
      // リンク密度が極端に高い、または純粋な矢印/パンくず記号（[リンク] > [リンク] 等）のみの場合はハイライト候補から除外
      if (!currentHeading) {
        const isNavOnly =
          fullText.length < 250 &&
          (/^(?:.*?[>›\\]\s*)+.*$/s.test(fullText) ||
            // 「[リンク](URL)」の並びだけか。.+ が間のリンクも区切りも飲み込めるので、繰り返しの形 (?:\[.+?\]\(.+?\)…)+ と同じものに当たる
            // （繰り返しの形は、当たらない入力で組み合わせが指数で増え、121 字で 2 秒かかった）
            /^\[.+\]\(.+\)\s*(?:\\?>|›|>)?\s*$/s.test(fullText)) &&
          (fullText.includes('](') || fullText.includes('>') || fullText.includes('\\>'));
        if (isNavOnly) {
          currentParagraphs = [];
          return;
        }
      }

      // H1見出しが存在しないドキュメントの場合、パンくずルートタイトルを親文脈として注入
      let finalHeading = currentHeading;
      const hasH1 = headingStack.some((h) => h.level === 1);
      if (rootContext && !hasH1 && (!finalHeading?.includes(rootContext))) {
        finalHeading = finalHeading ? `${rootContext} > ${finalHeading}` : rootContext;
      }

      sections.push({
        rawHeading: currentRawHeading,
        heading: finalHeading,
        headingLevel: currentLevel,
        paragraphs: keptLines,
        fullText,
        charLength: fullText.length,
        startIndex: sectionStartIndex,
      });
    }
    currentParagraphs = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // コードブロックトグル
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      currentParagraphs.push(line);
      runningIndex += line.length + 1;
      continue;
    }

    if (!inCodeBlock) {
      // 見出し検出: 通常の # 見出しに加え、リスト内の見出し (- ### や * ## 等) もサポート
      const headingMatch = trimmed.match(/^(?:[-*+]\s+)?(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        flush();
        const level = headingMatch[1].length;
        const rawTitle = headingMatch[2].trim();

        // 階層スタックの更新: 自分以上の深さの祖先をポップしてパンくずを構築
        while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
          headingStack.pop();
        }
        headingStack.push({ level, heading: rawTitle });

        currentLevel = level;
        currentHeading = headingStack.map((h) => h.heading).join(' > ');
        currentRawHeading = line;
        sectionStartIndex = runningIndex;
        runningIndex += line.length + 1;
        continue;
      }
    }

    currentParagraphs.push(line);
    runningIndex += line.length + 1;
  }
  flush();

  // 見出しが存在するが本文が全くないドキュメント（見出し行のみのファイル）への救済
  if (sections.length === 0 && headingStack.length > 0) {
    sections.push({
      rawHeading: currentRawHeading,
      heading: currentHeading,
      headingLevel: currentLevel,
      paragraphs: [currentHeading],
      fullText: currentHeading,
      charLength: currentHeading.length,
      startIndex: 0,
    });
  }

  // 見出しが1つも検出されず空行区切り段落が存在する場合は段落単位に分割
  if (sections.length === 1 && !sections[0].heading && sections[0].fullText.includes('\n\n')) {
    const rawParagraphs = sections[0].fullText
      .split(/\n\s*\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    // リスト構造（- 項目\n\n  値）の泣き別れを防止するマージ処理
    const mergedParagraphs: string[] = [];
    for (const p of rawParagraphs) {
      const prev = mergedParagraphs.length > 0 ? mergedParagraphs[mergedParagraphs.length - 1] : null;
      // 直前がリスト項目（- や * 等で始まる短い項目名）で、現在のブロックがその値と思われる場合は結合
      const isListItemHeader = prev && /^[-*+]\s+[^\n]{1,40}$/.test(prev);
      if (isListItemHeader) {
        mergedParagraphs[mergedParagraphs.length - 1] = `${prev}\n\n${p}`;
      } else {
        mergedParagraphs.push(p);
      }
    }

    if (mergedParagraphs.length > 1) {
      let offset = 0;
      return mergedParagraphs.map((p) => {
        const sec: ParsedSection = {
          rawHeading: '',
          heading: '',
          headingLevel: 0,
          paragraphs: [p],
          fullText: p,
          charLength: p.length,
          startIndex: offset,
        };
        offset += p.length + 2;
        return sec;
      });
    }
  }

  return sections;
}

/**
 * クエリ文字列のトークナイズと重要語選択 (Term Selection)
 * Intl.Segmenter + 英数区切り、重複除去、局所識別度優先
 */
export function tokenizeAndSelectTerms(
  query: string,
  sections: ParsedSection[],
  maxTerms = 6,
): { terms: string[]; rawQuery: string } {
  const rawQuery = (query || '').trim();
  if (!rawQuery) return { terms: [], rawQuery: '' };

  const rawTerms = new Set<string>();

  // 0. ユーザーがスペース区切りで指定したフレーズ（長さ2以上の複合語・完全一致候補）を優先保持
  const rawPhrases = rawQuery.split(/[\s　]+/).map((p) => p.trim().toLowerCase());
  for (const phrase of rawPhrases) {
    if (
      phrase.length >= 2 &&
      !/^[、。・！？!?\s\-_=+/\\|:;'"()[\]{}]+$/.test(phrase) &&
      !/^(の|は|が|を|に|へ|と|で|て|た|も|から|まで|より|など)$/.test(phrase)
    ) {
      rawTerms.add(phrase);
    }
  }

  // 1. 英語・数値・ハイフン語
  const enWords = rawQuery.toLowerCase().match(/[a-z0-9_-]{2,}/g) || [];
  for (const w of enWords) {
    rawTerms.add(w);
  }

  // 2. 日本語形態素/単語分割 (Intl.Segmenter)
  if (typeof Intl !== 'undefined' && (Intl as any).Segmenter) {
    try {
      const segmenter = new (Intl as any).Segmenter('ja', { granularity: 'word' });
      for (const seg of segmenter.segment(rawQuery)) {
        const word = seg.segment.trim().toLowerCase();
        // 2文字以上の実質語（助詞・記号ノイズ除外）
        if (
          word.length >= 2 &&
          !/^[、。・！？!?\s\-_=+/\\|:;'"()[\]{}]+$/.test(word) &&
          !/^(の|は|が|を|に|へ|と|で|て|た|も|から|まで|より|など)$/.test(word)
        ) {
          rawTerms.add(word);
        }
      }
    } catch {
      // Intl fallback
    }
  }

  // もし単語が抽出できずクエリ全体が日本語単語の場合
  if (rawTerms.size === 0 && rawQuery.length >= 2) {
    rawTerms.add(rawQuery.toLowerCase());
  }

  const allTerms = Array.from(rawTerms);
  if (allTerms.length <= maxTerms) {
    return { terms: allTerms, rawQuery };
  }

  // maxTerms を超える場合、セクション内 DF (Document Frequency) と単語長に基づく識別性スコアリング
  // 単純な先頭切り捨てを禁止
  const N = Math.max(1, sections.length);
  const scoredTerms = allTerms.map((term) => {
    let df = 0;
    for (const sec of sections) {
      if (
        sec.heading.toLowerCase().includes(term) ||
        sec.fullText.toLowerCase().includes(term)
      ) {
        df++;
      }
    }
    // 識別性: 0 < df < N の特異的語を優遇 (df=0 または df=N は情報量が低い)
    const selectivity = df > 0 ? (N - df + 0.5) / (df + 0.5) : 0.1;
    const lengthScore = Math.min(term.length, 6);
    const score = Math.log(1 + selectivity) * (1 + 0.2 * lengthScore);
    return { term, score, df };
  });

  scoredTerms.sort((a, b) => b.score - a.score);
  return {
    terms: scoredTerms.slice(0, maxTerms).map((t) => t.term),
    rawQuery,
  };
}
