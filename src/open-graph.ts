import type { Page } from 'playwright';

export type OpenGraphIssueType =
  | 'missing-og-title'
  | 'missing-og-image'
  | 'missing-og-description'
  | 'missing-twitter-card'
  | 'og-image-too-small'
  | 'og-image-unreachable'
  | 'og-image-wrong-ratio'
  | 'og-title-too-long'
  | 'og-description-too-long';

export interface OpenGraphIssue {
  type: OpenGraphIssueType;
  detail?: string;
}

export interface OpenGraphResult {
  page: string;
  openGraph: {
    title?: string;
    type?: string;
    image?: string;
    url?: string;
    description?: string;
    siteName?: string;
    locale?: string;
    imageWidth?: number;
    imageHeight?: number;
    imageAlt?: string;
  };
  twitter: {
    card?: string;
    title?: string;
    description?: string;
    image?: string;
    site?: string;
    creator?: string;
  };
  facebook: {
    appId?: string;
  };
  imageReachable: boolean;
  imageMimeType?: string;
  imageActualWidth?: number;
  imageActualHeight?: number;
  issues: OpenGraphIssue[];
  passed: boolean;
}

const MIN_IMAGE_WIDTH = 600;
const MIN_IMAGE_HEIGHT = 315;
const TARGET_RATIO = 1.91;
const RATIO_TOLERANCE = 0.2;
const MAX_TITLE_LENGTH = 60;
const MAX_DESCRIPTION_LENGTH = 160;
const IMAGE_LOAD_TIMEOUT_MS = 5000;
const FETCH_TIMEOUT_MS = 5000;

interface ExtractedMeta {
  og: Record<string, string>;
  twitter: Record<string, string>;
  fb: Record<string, string>;
}

interface ImageDimensions {
  width: number;
  height: number;
}

function parseIntOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

async function fetchImageHead(
  imageUrl: string,
): Promise<{ reachable: boolean; contentType?: string; status?: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(imageUrl, { method: 'HEAD', signal: controller.signal });
    const contentType = res.headers.get('content-type') ?? undefined;
    return { reachable: res.ok, contentType, status: res.status };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function loadImageDimensions(
  page: Page,
  imageUrl: string,
): Promise<ImageDimensions | undefined> {
  try {
    const dims = await page.evaluate(
      async ({ url, timeoutMs }): Promise<{ width: number; height: number } | null> => {
        return await new Promise((resolve) => {
          const img = new Image();
          const timer = window.setTimeout(() => {
            img.src = '';
            resolve(null);
          }, timeoutMs);
          img.onload = () => {
            window.clearTimeout(timer);
            resolve({ width: img.naturalWidth, height: img.naturalHeight });
          };
          img.onerror = () => {
            window.clearTimeout(timer);
            resolve(null);
          };
          img.src = url;
        });
      },
      { url: imageUrl, timeoutMs: IMAGE_LOAD_TIMEOUT_MS },
    );
    if (dims && dims.width > 0 && dims.height > 0) {
      return dims;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function checkOpenGraph(page: Page): Promise<OpenGraphResult> {
  const url = page.url();
  const issues: OpenGraphIssue[] = [];

  const meta: ExtractedMeta = await page.evaluate(() => {
    const og: Record<string, string> = {};
    const twitter: Record<string, string> = {};
    const fb: Record<string, string> = {};

    const metas = document.querySelectorAll('meta');
    metas.forEach((m) => {
      const property = m.getAttribute('property');
      const name = m.getAttribute('name');
      const content = m.getAttribute('content');
      if (content === null) return;

      if (property && property.startsWith('og:')) {
        og[property.slice(3)] = content;
      } else if (property && property.startsWith('fb:')) {
        fb[property.slice(3)] = content;
      } else if (name && name.startsWith('twitter:')) {
        twitter[name.slice(8)] = content;
      } else if (property && property.startsWith('twitter:')) {
        twitter[property.slice(8)] = content;
      }
    });

    return { og, twitter, fb };
  });

  const openGraph: OpenGraphResult['openGraph'] = {
    title: meta.og['title'],
    type: meta.og['type'],
    image: meta.og['image'],
    url: meta.og['url'],
    description: meta.og['description'],
    siteName: meta.og['site_name'],
    locale: meta.og['locale'],
    imageWidth: parseIntOrUndefined(meta.og['image:width']),
    imageHeight: parseIntOrUndefined(meta.og['image:height']),
    imageAlt: meta.og['image:alt'],
  };

  const twitter: OpenGraphResult['twitter'] = {
    card: meta.twitter['card'],
    title: meta.twitter['title'],
    description: meta.twitter['description'],
    image: meta.twitter['image'],
    site: meta.twitter['site'],
    creator: meta.twitter['creator'],
  };

  const facebook: OpenGraphResult['facebook'] = {
    appId: meta.fb['app_id'],
  };

  if (!openGraph.title) {
    issues.push({ type: 'missing-og-title' });
  } else if (openGraph.title.length > MAX_TITLE_LENGTH) {
    issues.push({
      type: 'og-title-too-long',
      detail: `og:title is ${openGraph.title.length} chars (max ${MAX_TITLE_LENGTH})`,
    });
  }

  if (!openGraph.description) {
    issues.push({ type: 'missing-og-description' });
  } else if (openGraph.description.length > MAX_DESCRIPTION_LENGTH) {
    issues.push({
      type: 'og-description-too-long',
      detail: `og:description is ${openGraph.description.length} chars (max ${MAX_DESCRIPTION_LENGTH})`,
    });
  }

  if (!twitter.card) {
    issues.push({ type: 'missing-twitter-card' });
  }

  let imageReachable = false;
  let imageMimeType: string | undefined;
  let imageActualWidth: number | undefined;
  let imageActualHeight: number | undefined;

  if (!openGraph.image) {
    issues.push({ type: 'missing-og-image' });
  } else {
    let absoluteImageUrl: string;
    try {
      absoluteImageUrl = new URL(openGraph.image, url).href;
    } catch {
      absoluteImageUrl = openGraph.image;
    }

    const headResult = await fetchImageHead(absoluteImageUrl);
    imageReachable = headResult.reachable;
    imageMimeType = headResult.contentType;

    if (!imageReachable) {
      issues.push({
        type: 'og-image-unreachable',
        detail: headResult.status
          ? `og:image returned HTTP ${headResult.status}`
          : 'og:image fetch failed',
      });
    }

    const dims = await loadImageDimensions(page, absoluteImageUrl);
    if (dims) {
      imageActualWidth = dims.width;
      imageActualHeight = dims.height;
    } else if (openGraph.imageWidth && openGraph.imageHeight) {
      imageActualWidth = openGraph.imageWidth;
      imageActualHeight = openGraph.imageHeight;
    }

    if (imageActualWidth !== undefined && imageActualHeight !== undefined) {
      if (
        imageActualWidth < MIN_IMAGE_WIDTH ||
        imageActualHeight < MIN_IMAGE_HEIGHT
      ) {
        issues.push({
          type: 'og-image-too-small',
          detail: `og:image is ${imageActualWidth}x${imageActualHeight} (min ${MIN_IMAGE_WIDTH}x${MIN_IMAGE_HEIGHT})`,
        });
      }

      if (imageActualHeight > 0) {
        const ratio = imageActualWidth / imageActualHeight;
        if (Math.abs(ratio - TARGET_RATIO) > RATIO_TOLERANCE) {
          issues.push({
            type: 'og-image-wrong-ratio',
            detail: `og:image aspect ratio ${ratio.toFixed(2)}:1 (target ${TARGET_RATIO}:1 ±${RATIO_TOLERANCE})`,
          });
        }
      }
    }
  }

  const passed = issues.length === 0;

  return {
    page: url,
    openGraph,
    twitter,
    facebook,
    imageReachable,
    imageMimeType,
    imageActualWidth,
    imageActualHeight,
    issues,
    passed,
  };
}
