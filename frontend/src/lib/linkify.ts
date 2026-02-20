/**
 * 链接检测与转换工具
 *
 * 将文本中的裸 URL 和本地文件路径转换为可点击的 Markdown 链接，
 * 同时保留已有的 Markdown 链接格式不变。
 */

/**
 * URL 正则表达式
 * 匹配 http/https/ftp 开头的链接
 */
const URL_REGEX = /(?<![(\[])(https?:\/\/|ftp:\/\/)[^\s<>\[\]"'`]+(?<![.,;:!?\])'""])/gi;

/**
 * Windows 路径正则表达式
 * 匹配 C:\path 或 C:/path 格式
 */
const WINDOWS_PATH_REGEX = /(?<![(\[])([A-Za-z]:[\\/][^\s<>\[\]"'`*?|]+)(?<![.,;:!?\])'""])/g;

/**
 * Unix/Mac 路径正则表达式
 * 匹配 /home/xxx 或 ~/xxx 格式（至少包含两级目录）
 */
const UNIX_PATH_REGEX = /(?<![(\[])((\/(?:[\w.-]+\/)+[\w.-]+)|(~\/[\w./-]+))(?<![.,;:!?\])'""])/g;

/**
 * UNC 路径正则表达式
 * 匹配 \\server\share 格式
 */
const UNC_PATH_REGEX = /(?<![(\[])(\\\\[^\s<>\[\]"'`]+)(?<![.,;:!?\])'""])/g;

/**
 * Markdown 链接正则表达式（用于检测已存在的链接）
 * 匹配 [text](url) 格式
 */
const MD_LINK_REGEX = /\[([^\]]*)\]\(([^)]+)\)/g;

/**
 * 检查位置是否在 Markdown 链接内部
 */
function isInsideMarkdownLink(text: string, start: number, end: number): boolean {
    // 重置正则状态
    MD_LINK_REGEX.lastIndex = 0;
    let match;
    while ((match = MD_LINK_REGEX.exec(text)) !== null) {
        const linkStart = match.index;
        const linkEnd = linkStart + match[0].length;
        // 检查当前匹配是否在 Markdown 链接范围内
        if (start >= linkStart && end <= linkEnd) {
            return true;
        }
    }
    return false;
}

/**
 * 检查位置是否在代码块或行内代码内
 */
function isInsideCode(text: string, position: number): boolean {
    // 检查是否在 ``` 代码块内
    const codeBlockRegex = /```[\s\S]*?```/g;
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
        if (position >= match.index && position < match.index + match[0].length) {
            return true;
        }
    }

    // 检查是否在 ` 行内代码内
    const inlineCodeRegex = /`[^`]+`/g;
    while ((match = inlineCodeRegex.exec(text)) !== null) {
        if (position >= match.index && position < match.index + match[0].length) {
            return true;
        }
    }

    return false;
}

interface LinkMatch {
    start: number;
    end: number;
    text: string;
    type: 'url' | 'path';
}

/**
 * 查找所有需要转换的链接
 */
function findLinks(text: string): LinkMatch[] {
    const matches: LinkMatch[] = [];

    // 查找 URL
    URL_REGEX.lastIndex = 0;
    let match;
    while ((match = URL_REGEX.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (!isInsideMarkdownLink(text, start, end) && !isInsideCode(text, start)) {
            matches.push({ start, end, text: match[0], type: 'url' });
        }
    }

    // 查找 Windows 路径
    WINDOWS_PATH_REGEX.lastIndex = 0;
    while ((match = WINDOWS_PATH_REGEX.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (!isInsideMarkdownLink(text, start, end) && !isInsideCode(text, start)) {
            matches.push({ start, end, text: match[0], type: 'path' });
        }
    }

    // 查找 Unix 路径
    UNIX_PATH_REGEX.lastIndex = 0;
    while ((match = UNIX_PATH_REGEX.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (!isInsideMarkdownLink(text, start, end) && !isInsideCode(text, start)) {
            matches.push({ start, end, text: match[0], type: 'path' });
        }
    }

    // 查找 UNC 路径
    UNC_PATH_REGEX.lastIndex = 0;
    while ((match = UNC_PATH_REGEX.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (!isInsideMarkdownLink(text, start, end) && !isInsideCode(text, start)) {
            matches.push({ start, end, text: match[0], type: 'path' });
        }
    }

    // 按位置排序，从后往前处理以避免索引偏移
    matches.sort((a, b) => b.start - a.start);

    return matches;
}

/**
 * 将文本中的裸 URL 和本地路径转换为 Markdown 链接
 *
 * @param text 原始文本
 * @returns 转换后的文本
 */
export function linkifyText(text: string): string {
    const matches = findLinks(text);

    if (matches.length === 0) {
        return text;
    }

    let result = text;

    // 从后往前替换，避免索引偏移
    for (const match of matches) {
        const linkText = match.text;
        // URL 直接使用原文本作为链接
        // 本地路径使用 file:// 协议
        const href = match.type === 'url'
            ? linkText
            : `file://${linkText.replace(/\\/g, '/')}`;

        // 生成 Markdown 链接，显示文本使用原路径（保持原样式）
        const markdownLink = `[${linkText}](${href})`;

        result = result.slice(0, match.start) + markdownLink + result.slice(match.end);
    }

    return result;
}

/**
 * 检查文本是否包含需要链接化的内容
 */
export function hasLinkifiableContent(text: string): boolean {
    return findLinks(text).length > 0;
}
