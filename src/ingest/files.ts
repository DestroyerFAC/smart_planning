/**
 * Transformation d'un fichier utilisateur en images pretes pour l'API vision.
 *
 * Trois problemes concrets sont traites ici :
 *  - Une photo d'iPhone fait 3 a 5 Mo et 4000 px de large. Envoyee telle quelle
 *    elle depasse la limite de l'API et coute cher en tokens pour aucun gain de
 *    lisibilite : on redimensionne a 1600 px.
 *  - Une photo prise en portrait porte son orientation dans l'EXIF. Sans
 *    `imageOrientation: 'from-image'`, le tableau arrive couche et le modele
 *    lit n'importe quoi.
 *  - Un PDF n'est pas accepte par l'API : chaque page est rasterisee via pdf.js.
 */
import { Err, Ok, appError } from '../types';
import type { Result, SourceKind } from '../types';

/** Cote le plus long apres redimensionnement. Compromis lisibilite / poids. */
const MAX_DIMENSION = 1600;
/** Qualite JPEG : au-dela le gain visuel est nul sur du texte imprime. */
const JPEG_QUALITY = 0.82;
/** Garde-fou : un PDF de 200 pages ne doit pas lancer 200 appels API. */
const MAX_PAGES = 8;
/** Refus en amont, avant de saturer la memoire du telephone. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface PreparedSource {
  readonly kind: SourceKind;
  readonly name: string;
  /** Une data URL JPEG par page/image. */
  readonly images: string[];
  /** Pages ignorees a cause du plafond, pour prevenir l'utilisateur. */
  readonly skippedPages: number;
}

export function isSupportedFile(file: File): boolean {
  return file.type.startsWith('image/') || file.type === 'application/pdf'
    || file.name.toLowerCase().endsWith('.pdf');
}

/** Point d'entree unique : accepte une image ou un PDF. */
export async function prepareFile(
  file: File,
  onProgress?: (done: number, total: number) => void,
): Promise<Result<PreparedSource>> {
  if (file.size > MAX_FILE_BYTES) {
    return Err(appError('FILE_TOO_LARGE', 'Fichier trop lourd (max 25 Mo).', {
      hint: 'Prends la photo en qualité standard plutôt qu’en HD.',
    }));
  }

  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (isPdf) return preparePdf(file, onProgress);
  if (file.type.startsWith('image/')) return prepareImage(file, onProgress);

  return Err(appError('UNSUPPORTED_FILE', 'Format non pris en charge.', {
    hint: 'Utilise une photo (JPEG, PNG, HEIC) ou un PDF.',
  }));
}

/* ------------------------------------------------------------------ Images */

async function prepareImage(
  file: File,
  onProgress?: (done: number, total: number) => void,
): Promise<Result<PreparedSource>> {
  onProgress?.(0, 1);
  try {
    const bitmap = await decodeImage(file);
    const dataUrl = await bitmapToJpegDataUrl(bitmap);
    bitmap.close?.();
    onProgress?.(1, 1);
    return Ok({ kind: 'image', name: file.name, images: [dataUrl], skippedPages: 0 });
  } catch (cause) {
    return Err(appError('UNSUPPORTED_FILE', 'Image illisible.', {
      hint: 'Le fichier est peut-être corrompu. Réessaie avec une autre photo.',
      cause,
    }));
  }
}

/**
 * Decode un fichier image en respectant l'orientation EXIF.
 * `createImageBitmap` est prefere pour son decodage hors thread principal ;
 * le repli couvre les navigateurs qui ignorent l'option `imageOrientation`.
 */
async function decodeImage(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return await createImageBitmap(image);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function scaledSize(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= MAX_DIMENSION) return { width, height };
  const ratio = MAX_DIMENSION / longest;
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
}

async function bitmapToJpegDataUrl(bitmap: ImageBitmap): Promise<string> {
  const { width, height } = scaledSize(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D indisponible');

  // Le JPEG n'a pas de canal alpha : sans fond blanc, un PNG transparent
  // deviendrait noir et le texte disparaitrait.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, width, height);

  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

/* --------------------------------------------------------------------- PDF */

async function preparePdf(
  file: File,
  onProgress?: (done: number, total: number) => void,
): Promise<Result<PreparedSource>> {
  try {
    // Import dynamique : pdf.js pese ~1 Mo et ne doit pas ralentir le demarrage
    // de l'app pour les utilisateurs qui n'importent que des photos.
    const pdfjs = await import('pdfjs-dist');
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

    const buffer = await file.arrayBuffer();
    const document_ = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;

    const total = Math.min(document_.numPages, MAX_PAGES);
    const images: string[] = [];

    for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
      onProgress?.(pageNumber - 1, total);
      images.push(await renderPdfPage(document_, pageNumber));
    }
    onProgress?.(total, total);

    await document_.destroy();

    return Ok({
      kind: 'pdf',
      name: file.name,
      images,
      skippedPages: Math.max(0, document_.numPages - total),
    });
  } catch (cause) {
    return Err(appError('PDF_RENDER', 'Lecture du PDF impossible.', {
      hint: 'S’il est protégé par mot de passe, exporte-le en photo puis réessaie.',
      cause,
    }));
  }
}

interface RenderablePdf {
  getPage(pageNumber: number): Promise<{
    getViewport(params: { scale: number }): { width: number; height: number };
    render(params: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
    cleanup(): void;
  }>;
}

async function renderPdfPage(document_: RenderablePdf, pageNumber: number): Promise<string> {
  const page = await document_.getPage(pageNumber);

  // On mesure a l'echelle 1 pour calculer le facteur qui amene la page a
  // MAX_DIMENSION : un PDF A4 rendu a l'echelle 1 fait ~600 px, illisible.
  const natural = page.getViewport({ scale: 1 });
  const scale = MAX_DIMENSION / Math.max(natural.width, natural.height);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);

  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D indisponible');

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  page.cleanup();

  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}
