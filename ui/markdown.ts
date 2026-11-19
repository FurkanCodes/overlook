/**
 * A small, safe markdown renderer: it builds DOM nodes and never uses
 * innerHTML, so nothing in the text can run as code.
 * Supports: # headings, paragraphs, - and 1. lists, **bold**, *italic*,
 * `code`, and [links](https://...) to http(s) only.
 */
import { h } from './dom.js';

function inline(text: string): Node[] {
  const out: Node[] = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push(document.createTextNode(text.slice(last, i)));
    if (m[2] !== undefined) out.push(h('strong', {}, m[2]));
    else if (m[3] !== undefined) out.push(h('em', {}, m[3]));
    else if (m[4] !== undefined) out.push(h('code', {}, m[4]));
    else if (m[5] !== undefined && m[6] !== undefined) {
      const href = m[6];
      if (/^https?:\/\//i.test(href)) out.push(h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, m[5]));
      else out.push(document.createTextNode(m[5]));
    }
    last = i + m[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

export function renderMarkdown(src: string): HTMLElement {
  const root = h('div', { class: 'md' });
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [];
  let list: HTMLElement | null = null;
  const flushPara = () => {
    if (para.length) {
      const p = h('p');
      p.append(...inline(para.join(' ')));
      root.append(p);
      para = [];
    }
  };
  const flushList = () => {
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      // Text panels sit under the page's h1 beside panels titled with h2, so
      // their headings start at h3 and never skip a level: # to ### become
      // h3, deeper ones h4.
      const level = (heading[1]!.length >= 4 ? 4 : 3) as 3 | 4;
      const el = h(`h${level}` as 'h3', {});
      el.append(...inline(heading[2]!));
      root.append(el);
    } else if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = h(tag);
        root.append(list);
      }
      const li = h('li');
      li.append(...inline((bullet ?? numbered)![1]!));
      list.append(li);
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  return root;
}
