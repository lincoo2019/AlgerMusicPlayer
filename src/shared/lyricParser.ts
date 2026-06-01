/**
 * 歌词解析工具 - 用于将 LRC/YRC 格式歌词转换为嵌入音频标签的格式
 * 支持：
 * - 标准 LRC 格式: [00:25.47]歌词文本
 * - 网易云 YRC 逐字格式: [92260,4740](0,1000,0)歌(1000,500,0)词
 * - 网易云 YRC 元数据: {"t":0,"c":[{"tx":"作词："}]}
 */

export interface ParsedLyricLine {
  text: string;
  startTimeMs: number;
}

export interface ParsedLyricResult {
  /** 纯文本歌词（无时间戳，用于 USLT） */
  plainText: string;
  /** 带时间戳的歌词行（用于 SYLT） */
  timedLines: ParsedLyricLine[];
  /** 标准 LRC 格式歌词（用于 .lrc 文件） */
  lrcText: string;
}

// YRC 元数据行: {"t":0,"c":[{"tx":"作词："}]}
const YRC_META_PATTERN = /^\s*\{.*"c"\s*:.*\}\s*$/;
// YRC 逐字歌词行: [92260,4740](0,1000,0)歌(1000,500,0)词
const YRC_LINE_PATTERN = /^\[(\d+),(\d+)\](.+)$/;
// YRC 单词: (startTime,duration,flag)text
const YRC_WORD_PATTERN = /\((\d+),(\d+),\d+\)([^(]*)/g;
// 标准 LRC 行: [00:25.47]歌词文本
const LRC_TIME_PATTERN = /^\[(\d{2}):(\d{2})[.:](\d{2,3})\](.*)$/;

/**
 * 解析歌词字符串，自动检测 LRC/YRC 格式
 */
export function parseLyricsForEmbedding(lyricsStr: string): ParsedLyricResult {
  if (!lyricsStr || typeof lyricsStr !== 'string') {
    return { plainText: '', timedLines: [], lrcText: '' };
  }

  const lines = lyricsStr.trim().split('\n');
  const timedLines: ParsedLyricLine[] = [];
  const plainLines: string[] = [];
  const lrcLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // 1. YRC 元数据行: {"t":0,"c":[{"tx":"作词："}]}
    if (YRC_META_PATTERN.test(line)) {
      try {
        const data = JSON.parse(line);
        if (data.c && Array.isArray(data.c)) {
          const text = data.c
            .filter((item: any) => item && typeof item.tx === 'string')
            .map((item: any) => item.tx)
            .join('');
          if (text) {
            plainLines.push(text);
            if (typeof data.t === 'number' && data.t >= 0) {
              timedLines.push({ text, startTimeMs: data.t });
              lrcLines.push(`[${formatMsToLrcTime(data.t)}]${text}`);
            }
          }
        }
      } catch {
        // JSON 解析失败，跳过
      }
      continue;
    }

    // 2. YRC 逐字歌词行: [92260,4740](0,1000,0)歌(1000,500,0)词
    const yrcMatch = line.match(YRC_LINE_PATTERN);
    if (yrcMatch) {
      const startTime = parseInt(yrcMatch[1], 10);
      const content = yrcMatch[3];

      YRC_WORD_PATTERN.lastIndex = 0;
      const textParts: string[] = [];
      let wordMatch: RegExpExecArray | null;
      while ((wordMatch = YRC_WORD_PATTERN.exec(content)) !== null) {
        const wordText = wordMatch[3];
        if (wordText) {
          textParts.push(wordText);
        }
      }

      const fullText = textParts.join('').trim();
      if (fullText) {
        timedLines.push({ text: fullText, startTimeMs: startTime });
        plainLines.push(fullText);
        lrcLines.push(`[${formatMsToLrcTime(startTime)}]${fullText}`);
      }
      continue;
    }

    // 3. 标准 LRC 行: [00:25.47]歌词文本
    const lrcMatch = line.match(LRC_TIME_PATTERN);
    if (lrcMatch) {
      const minutes = parseInt(lrcMatch[1], 10);
      const seconds = parseInt(lrcMatch[2], 10);
      const ms = parseInt(lrcMatch[3].padEnd(3, '0'), 10);
      const text = lrcMatch[4].trim();

      if (text) {
        const startTimeMs = minutes * 60000 + seconds * 1000 + ms;
        timedLines.push({ text, startTimeMs });
        plainLines.push(text);
        lrcLines.push(line);
      }
      continue;
    }

    // 4. 纯文本行（无时间戳）
    const text = line.replace(/\[\d{2}:\d{2}[.:]\d{2,3}\]/g, '').trim();
    if (text) {
      plainLines.push(text);
    }
  }

  // 按时间排序
  timedLines.sort((a, b) => a.startTimeMs - b.startTimeMs);

  return {
    plainText: plainLines.join('\n'),
    timedLines,
    lrcText: lrcLines.join('\n')
  };
}

/**
 * 合并原文歌词和翻译歌词
 */
export function mergeLyricsForEmbedding(
  originalResult: ParsedLyricResult,
  translationResult: ParsedLyricResult | null
): ParsedLyricResult {
  if (!translationResult || translationResult.plainText === '') {
    return originalResult;
  }

  // 构建翻译时间映射
  const transMap = new Map<number, string>();
  for (const line of translationResult.timedLines) {
    transMap.set(line.startTimeMs, line.text);
  }

  const mergedTimedLines: ParsedLyricLine[] = [];
  const mergedPlainLines: string[] = [];
  const mergedLrcLines: string[] = [];

  for (const line of originalResult.timedLines) {
    mergedTimedLines.push(line);
    mergedPlainLines.push(line.text);
    mergedLrcLines.push(`[${formatMsToLrcTime(line.startTimeMs)}]${line.text}`);

    const trans = transMap.get(line.startTimeMs);
    if (trans) {
      mergedTimedLines.push({ text: trans, startTimeMs: line.startTimeMs });
      mergedPlainLines.push(trans);
      mergedLrcLines.push(`[${formatMsToLrcTime(line.startTimeMs)}]${trans}`);
    }
  }

  // 如果原文没有时间戳行但有纯文本行，合并翻译纯文本
  if (originalResult.timedLines.length === 0 && originalResult.plainText) {
    const origLines = originalResult.plainText.split('\n');
    const transLines = translationResult.plainText.split('\n');
    const merged: string[] = [];
    for (let i = 0; i < origLines.length; i++) {
      merged.push(origLines[i]);
      if (i < transLines.length && transLines[i]) {
        merged.push(transLines[i]);
      }
    }
    return {
      plainText: merged.join('\n'),
      timedLines: [],
      lrcText: ''
    };
  }

  return {
    plainText: mergedPlainLines.join('\n'),
    timedLines: mergedTimedLines,
    lrcText: mergedLrcLines.join('\n')
  };
}

function formatMsToLrcTime(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = Math.floor(ms % 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}
