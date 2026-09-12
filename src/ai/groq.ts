/**
 * Client de l'API Groq (compatible OpenAI).
 *
 * Trois contraintes ont dicte ce fichier :
 *  - Aucune exception ne doit remonter jusqu'a l'UI : tout renvoie un `Result`
 *    avec un message deja redige en francais et une piste de resolution.
 *  - Le catalogue de modeles de Groq evolue : le modele est configurable et
 *    l'app sait lister ceux reellement disponibles sur le compte.
 *  - Toutes les options recentes de l'API ne sont pas supportees par tous les
 *    modeles vision. On tente la configuration ideale, puis on retombe sur une
 *    configuration minimale plutot que d'echouer.
 */
import { extractionSchema, normalizeExtraction } from './schema';
import { buildSystemPrompt, buildUserPrompt, type PromptContext } from './prompt';
import { Err, Ok, appError } from '../types';
import type { AppError, Result } from '../types';
import type { CleanExtraction } from './schema';

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';

/** Modeles vision connus, proposes tant que le catalogue reel n'a pas ete lu. */
export const SUGGESTED_VISION_MODELS: readonly string[] = [
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'meta-llama/llama-4-scout-17b-16e-instruct',
] as const;

/**
 * Familles de modeles connues pour accepter des images, par ordre de
 * preference. Le score sert a classer un catalogue INCONNU : Groq retire et
 * ajoute des modeles regulierement, et coder en dur un identifiant garantit
 * qu'il finira par renvoyer 404.
 */
const VISION_HINTS: readonly { readonly pattern: RegExp; readonly score: number }[] = [
  { pattern: /maverick/i, score: 100 },
  { pattern: /scout/i, score: 90 },
  { pattern: /llama-?4/i, score: 80 },
  { pattern: /vision/i, score: 70 },
  { pattern: /llava|pixtral/i, score: 60 },
  { pattern: /(^|[-/])vl([-.]|$)/i, score: 55 },
  { pattern: /gemma-?3/i, score: 40 },
];

/** Familles qui ne traitent aucune image : audio, garde-fous, embeddings. */
const NON_VISION = /whisper|tts|embed|rerank|guard|moderation|safety/i;

function visionScore(id: string): number {
  return VISION_HINTS.reduce(
    (best, hint) => (hint.pattern.test(id) ? Math.max(best, hint.score) : best),
    0,
  );
}

/**
 * Classe un catalogue de modeles du plus au moins probable pour la lecture
 * d'images.
 *
 * Si aucun nom ne trahit une capacite vision, on renvoie quand meme les
 * modeles restants plutot qu'une liste vide : l'heuristique peut ignorer une
 * famille recente, et l'utilisateur reste libre de choisir.
 */
export function rankVisionModels(ids: readonly string[]): string[] {
  const usable = ids.filter((id) => !NON_VISION.test(id));
  const likely = usable
    .map((id) => ({ id, score: visionScore(id) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((entry) => entry.id);

  return likely.length > 0 ? likely : [...usable].sort();
}

const MAX_RETRIES = 3;
/** Plafond du repli exponentiel, pour ne pas figer l'UI sur un 429 tenace. */
const MAX_BACKOFF_MS = 8_000;

function baseUrl(proxyUrl: string): string {
  const trimmed = proxyUrl.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : DEFAULT_BASE_URL;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

/** Traduit un echec reseau brut en erreur exploitable par l'utilisateur. */
function networkError(cause: unknown): AppError {
  if (cause instanceof DOMException && cause.name === 'AbortError') {
    return appError('NETWORK', 'Analyse annulée.', { cause });
  }
  // Le navigateur ne distingue pas un blocage CORS d'une coupure reseau :
  // les deux remontent un TypeError opaque. On couvre donc les deux cas.
  return appError(
    'CORS_BLOCKED',
    'Impossible de joindre Groq depuis le navigateur.',
    {
      hint:
        'Vérifie ta connexion. Si le problème persiste alors que la connexion fonctionne, '
        + 'c’est un blocage CORS : renseigne une URL de proxy dans les Réglages.',
      cause,
    },
  );
}

/** Transforme une reponse HTTP en erreur, en recuperant le message de Groq. */
async function httpError(response: Response, model?: string): Promise<AppError> {
  let detail = '';
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const inner = (body as { error?: { message?: string } }).error;
      detail = inner?.message ?? '';
    }
  } catch {
    // Corps non-JSON : le statut HTTP suffit a caracteriser l'erreur.
  }

  switch (response.status) {
    case 401:
    case 403:
      return appError('AUTH', 'Clé API Groq refusée.', {
        hint: 'Vérifie la clé dans Réglages. Elle commence par "gsk_".',
      });
    case 413:
      return appError('FILE_TOO_LARGE', 'Image trop lourde pour l’API.', {
        hint: 'Recadre la photo sur le tableau, ou réduis sa définition.',
      });
    case 404:
      // Cas le plus frequent : un modele retire du catalogue. Signale par un
      // code distinct pour que l'appelant tente un repli sur un autre modele
      // plutot que d'abandonner.
      return appError(
        'MODEL_NOT_FOUND',
        model === undefined
          ? 'Ressource Groq introuvable.'
          : `Le modèle « ${model} » n’est pas disponible sur ton compte.`,
        {
          hint: detail
            || 'Ouvre Réglages → IA et touche « Tester la clé » pour choisir un modèle disponible.',
        },
      );
    case 429:
      return appError('RATE_LIMITED', 'Quota Groq atteint.', {
        hint: detail || 'Attends une minute avant de relancer l’analyse.',
      });
    default:
      return appError('MODEL_ERROR', `Groq a répondu ${response.status}.`, {
        hint: detail || undefined,
      });
  }
}

interface ChatOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly proxyUrl: string;
  readonly signal?: AbortSignal;
}

/** Corps d'une requete chat, avec ou sans contrainte JSON selon le repli. */
function buildBody(model: string, prompt: string, imageDataUrl: string, forceJson: boolean): string {
  return JSON.stringify({
    model,
    // Instructions et image dans le MEME message utilisateur : certains modeles
    // vision de Groq rejettent un message systeme accompagne d'une image.
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
    // Temperature nulle : on veut une lecture reproductible, pas de creativite.
    temperature: 0,
    max_completion_tokens: 8192,
    ...(forceJson ? { response_format: { type: 'json_object' } } : {}),
  });
}

/** Vrai si l'echec vient de l'option `response_format` et non du contenu. */
function isJsonModeUnsupported(error: AppError): boolean {
  if (error.code !== 'MODEL_ERROR') return false;
  const detail = `${error.message} ${error.hint ?? ''}`.toLowerCase();
  return detail.includes('response_format') || detail.includes('json_object') || detail.includes('json mode');
}

async function postChat(
  options: ChatOptions,
  prompt: string,
  imageDataUrl: string,
  forceJson: boolean,
): Promise<Result<string>> {
  let lastError: AppError = appError('NETWORK', 'Aucune tentative n’a abouti.');

  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${baseUrl(options.proxyUrl)}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: buildBody(options.model, prompt, imageDataUrl, forceJson),
        signal: options.signal ?? null,
      });
    } catch (cause) {
      const error = networkError(cause);
      if (error.code === 'NETWORK' && error.message === 'Analyse annulée.') return Err(error);
      return Err(error);
    }

    if (response.ok) {
      try {
        const payload: unknown = await response.json();
        const content = readMessageContent(payload);
        return content === null
          ? Err(appError('INVALID_RESPONSE', 'Réponse Groq vide ou inattendue.'))
          : Ok(content);
      } catch (cause) {
        return Err(appError('INVALID_RESPONSE', 'Réponse Groq illisible.', { cause }));
      }
    }

    lastError = await httpError(response, options.model);

    // Seuls le quota et les pannes serveur meritent une nouvelle tentative :
    // reessayer un 401 ne ferait que retarder l'affichage de l'erreur.
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === MAX_RETRIES - 1) return Err(lastError);

    const retryAfter = Number(response.headers.get('retry-after'));
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, MAX_BACKOFF_MS)
      : Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS);

    try {
      await sleep(backoff, options.signal);
    } catch (cause) {
      return Err(appError('NETWORK', 'Analyse annulée.', { cause }));
    }
  }

  return Err(lastError);
}

function readMessageContent(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  return typeof message?.content === 'string' ? message.content : null;
}

/**
 * Isole l'objet JSON dans la reponse du modele.
 * Sans le mode JSON force, le modele encadre souvent sa reponse d'un bloc
 * markdown ou d'une phrase d'introduction : on decoupe sur les accolades.
 */
function extractJsonObject(content: string): Result<unknown> {
  const withoutFences = content.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const first = withoutFences.indexOf('{');
  const last = withoutFences.lastIndexOf('}');
  if (first === -1 || last <= first) {
    return Err(appError('INVALID_RESPONSE', 'Le modèle n’a pas renvoyé de JSON.', {
      hint: 'Essaie un autre modèle dans Réglages, ou une photo plus nette.',
    }));
  }
  try {
    return Ok(JSON.parse(withoutFences.slice(first, last + 1)));
  } catch (cause) {
    return Err(appError('INVALID_RESPONSE', 'JSON du modèle invalide.', {
      hint: 'Relance l’analyse : le modèle a probablement tronqué sa réponse.',
      cause,
    }));
  }
}

/** Un appel d'extraction complet avec un modele donne, reponse validee. */
async function runExtraction(
  options: ChatOptions,
  prompt: string,
  imageDataUrl: string,
): Promise<Result<CleanExtraction>> {
  let response = await postChat(options, prompt, imageDataUrl, true);
  if (!response.ok && isJsonModeUnsupported(response.error)) {
    // Ce modele ne gere pas le mode JSON : on reessaie sans, le parseur
    // tolerant en aval sait recuperer un JSON entoure de texte.
    response = await postChat(options, prompt, imageDataUrl, false);
  }
  if (!response.ok) return response;

  const json = extractJsonObject(response.value);
  if (!json.ok) return json;

  const parsed = extractionSchema.safeParse(json.value);
  if (!parsed.success) {
    return Err(appError('INVALID_RESPONSE', 'Le modèle a renvoyé une structure inattendue.', {
      hint: parsed.error.issues[0]?.message,
      cause: parsed.error,
    }));
  }

  return Ok(normalizeExtraction(parsed.data));
}

export interface VisionExtraction {
  readonly extraction: CleanExtraction;
  /**
   * Modele reellement utilise. Differe de celui demande quand un repli
   * automatique a eu lieu ; l'appelant doit alors l'enregistrer.
   */
  readonly modelUsed: string;
}

/**
 * Analyse UNE image et renvoie le planning qu'elle contient.
 *
 * Si le modele enregistre a disparu du catalogue Groq — ce qui arrive, les
 * modeles etant retires regulierement — on interroge le catalogue du compte,
 * on choisit le meilleur candidat vision et on reessaie une fois. Sans ce
 * repli, l'application resterait definitivement cassee jusqu'a ce que
 * quelqu'un change une constante dans le code.
 */
export async function extractFromImage(
  imageDataUrl: string,
  context: PromptContext,
  options: ChatOptions,
): Promise<Result<VisionExtraction>> {
  if (options.apiKey.trim().length === 0) {
    return Err(appError('MISSING_API_KEY', 'Aucune clé API Groq enregistrée.', {
      hint: 'Ouvre Réglages et colle ta clé (console.groq.com/keys).',
    }));
  }

  const prompt = `${buildSystemPrompt()}\n\n---\n\n${buildUserPrompt(context)}`;

  const first = await runExtraction(options, prompt, imageDataUrl);
  if (first.ok) return Ok({ extraction: first.value, modelUsed: options.model });
  if (first.error.code !== 'MODEL_NOT_FOUND') return first;

  const replacement = await pickReplacementModel(options);
  // Aucun remplacant : on remonte l'erreur d'origine, qui nomme le modele
  // manquant et reste donc plus utile qu'un echec de decouverte.
  if (replacement === null) return first;

  const retry = await runExtraction({ ...options, model: replacement }, prompt, imageDataUrl);
  return retry.ok ? Ok({ extraction: retry.value, modelUsed: replacement }) : retry;
}

/** Meilleur modele vision disponible, hors celui qui vient d'echouer. */
async function pickReplacementModel(options: ChatOptions): Promise<string | null> {
  const catalog = await listModels(options.apiKey, options.proxyUrl, options.signal);
  if (!catalog.ok) return null;
  return rankVisionModels(catalog.value.map((model) => model.id))
    .find((id) => id !== options.model) ?? null;
}

export interface GroqModel {
  readonly id: string;
  readonly ownedBy: string;
}

/** Liste les modeles du compte, pour peupler le selecteur des reglages. */
export async function listModels(
  apiKey: string,
  proxyUrl: string,
  signal?: AbortSignal,
): Promise<Result<GroqModel[]>> {
  if (apiKey.trim().length === 0) {
    return Err(appError('MISSING_API_KEY', 'Renseigne d’abord ta clé API.'));
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl(proxyUrl)}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: signal ?? null,
    });
  } catch (cause) {
    return Err(networkError(cause));
  }

  if (!response.ok) return Err(await httpError(response));

  try {
    const payload: unknown = await response.json();
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data)) return Ok([]);
    const models = data
      .filter((item): item is { id: string; owned_by?: string } =>
        typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string')
      .map((item) => ({ id: item.id, ownedBy: item.owned_by ?? '' }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return Ok(models);
  } catch (cause) {
    return Err(appError('INVALID_RESPONSE', 'Liste de modèles illisible.', { cause }));
  }
}
