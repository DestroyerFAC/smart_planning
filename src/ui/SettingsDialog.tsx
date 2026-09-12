/**
 * Reglages, exports et maintenance.
 *
 * Note sur la cle API : dans une webapp, aucun stockage n'est equivalent au
 * Trousseau iOS. La cle vit dans IndexedDB, isolee par origine — aucun autre
 * site ne peut la lire — et n'est transmise qu'a api.groq.com. C'est le
 * meilleur compromis sans backend, et c'est dit franchement a l'utilisateur.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, ErrorAlert, Modal } from './components';
import { SUGGESTED_VISION_MODELS, listModels, rankVisionModels } from '../ai/groq';
import { buildIcs, downloadIcs } from '../export/ics';
import {
  clearAllData,
  exportBackup,
  getShiftsForPerson,
  importBackup,
  listImports,
  undoImport,
} from '../db/repo';
import { parseISODate } from '../lib/datetime';
import { usePlanning } from './store';
import type { AppError, ImportRecord, Shift } from '../types';

type Tab = 'ia' | 'export' | 'donnees';

export function SettingsDialog({ onClose }: { readonly onClose: () => void }): ReactNode {
  const [tab, setTab] = useState<Tab>('ia');

  return (
    <Modal title="R&eacute;glages" onClose={onClose}>
      <div className="filterbar" style={{ margin: '-16px -16px 16px', padding: '8px 16px' }}>
        {([['ia', 'IA'], ['export', 'Calendrier iPhone'], ['donnees', 'Données']] as const).map(
          ([value, label]) => (
            <button
              key={value}
              type="button"
              className="filterchip"
              aria-pressed={tab === value}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ),
        )}
      </div>

      {tab === 'ia' && <AiSettings />}
      {tab === 'export' && <ExportSettings />}
      {tab === 'donnees' && <DataSettings />}
    </Modal>
  );
}

/* --------------------------------------------------------------------- IA */

function AiSettings(): ReactNode {
  const { settings, updateSettings } = usePlanning();
  const [apiKey, setApiKey] = useState(settings.groqApiKey);
  const [revealed, setRevealed] = useState(false);
  const [models, setModels] = useState<readonly string[]>(SUGGESTED_VISION_MODELS);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'ok' | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  const handleTest = async (): Promise<void> => {
    setTesting(true);
    setError(null);
    setTestResult(null);

    await updateSettings({ groqApiKey: apiKey.trim() });
    const result = await listModels(apiKey.trim(), settings.proxyUrl);

    setTesting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    setTestResult('ok');
    // Classement par probabilite de savoir lire une image : proposer des
    // modeles audio ou texte seul ne ferait qu'induire en erreur.
    const ranked = rankVisionModels(result.value.map((model) => model.id));
    setModels(ranked);

    // Le modele enregistre a disparu du catalogue : on le remplace d'office
    // par le meilleur candidat, sinon le prochain import echouerait encore.
    const best = ranked[0];
    if (best !== undefined && !ranked.includes(settings.model)) {
      void updateSettings({ model: best });
    }
  };

  return (
    <div>
      <div className="field">
        <label className="field__label" htmlFor="groq-key">Cl&eacute; API Groq</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id="groq-key"
            className="input"
            type={revealed ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            placeholder="gsk_&hellip;"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            onBlur={() => void updateSettings({ groqApiKey: apiKey.trim() })}
          />
          <button
            type="button"
            className="btn"
            onClick={() => setRevealed((value) => !value)}
            aria-label={revealed ? 'Masquer la clé' : 'Afficher la clé'}
          >
            {revealed ? 'Masquer' : 'Voir'}
          </button>
        </div>
        <p className="field__hint">
          Gratuite sur <strong>console.groq.com/keys</strong>. Elle reste sur cet appareil et
          n&rsquo;est envoy&eacute;e qu&rsquo;&agrave; Groq pour lire tes plannings.
        </p>
      </div>

      <button
        type="button"
        className="btn btn--block"
        onClick={() => void handleTest()}
        disabled={testing || apiKey.trim() === ''}
      >
        {testing ? <span className="spinner" /> : 'Tester la clé'}
      </button>

      {error !== null && <div style={{ marginTop: 12 }}><ErrorAlert error={error} /></div>}
      {testResult === 'ok' && (
        <div style={{ marginTop: 12 }}>
          <Alert tone="success" title="Cl&eacute; valide">
            <p className="alert__hint" style={{ margin: 0 }}>
              {models.length} mod&egrave;le{models.length > 1 ? 's' : ''} disponible
              {models.length > 1 ? 's' : ''}.
            </p>
          </Alert>
        </div>
      )}

      <div className="field" style={{ marginTop: 16 }}>
        <label className="field__label" htmlFor="groq-model">Mod&egrave;le de lecture</label>
        <select
          id="groq-model"
          className="select"
          value={settings.model}
          onChange={(event) => void updateSettings({ model: event.target.value })}
        >
          {/* Le modele enregistre figure toujours dans la liste, meme s'il
              n'est plus propose par le compte : sinon le select afficherait
              silencieusement autre chose que ce qui est reellement utilise. */}
          {[...new Set([settings.model, ...models])].filter(Boolean).map((id) => (
            <option key={id} value={id}>{id}</option>
          ))}
        </select>
        <p className="field__hint">
          Il faut un mod&egrave;le <strong>vision</strong>. Si l&rsquo;analyse &eacute;choue,
          teste la cl&eacute; puis choisis un autre mod&egrave;le de la liste.
        </p>
      </div>

      <p className="section-title">Avanc&eacute;</p>
      <div className="field">
        <label className="field__label" htmlFor="proxy-url">URL de proxy (optionnel)</label>
        <input
          id="proxy-url"
          className="input"
          placeholder="https://mon-proxy.exemple/v1"
          value={settings.proxyUrl}
          onChange={(event) => void updateSettings({ proxyUrl: event.target.value })}
        />
        <p className="field__hint">
          &Agrave; renseigner uniquement si Groq refuse les appels directs depuis le navigateur
          (erreur CORS). Laisse vide sinon.
        </p>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- Export */

function ExportSettings(): ReactNode {
  const { people, settings, updateSettings } = usePlanning();
  const [scope, setScope] = useState<'me' | 'all'>('me');
  const [includeNonWork, setIncludeNonWork] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const me = people.find((person) => person.isMe) ?? null;

  const handleExport = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const targets = scope === 'me' && me !== null ? [me] : people;
      const collected: Shift[] = [];
      for (const person of targets) collected.push(...await getShiftsForPerson(person.id));

      if (collected.length === 0) {
        setMessage('Aucun poste à exporter.');
        return;
      }

      const content = buildIcs(collected, people, {
        calendarName: scope === 'me' ? 'Mon planning' : 'Planning équipe',
        includePersonName: scope === 'all',
        includeNonWork,
      });
      downloadIcs(content, scope === 'me' ? 'mon-planning' : 'planning-equipe');
      setMessage(`${collected.length} poste(s) exporté(s).`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Alert tone="info" title="Comment obtenir le widget sur l&rsquo;&eacute;cran d&rsquo;accueil">
        <ol style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
          <li>Touche <strong>Exporter vers le Calendrier</strong> ci-dessous.</li>
          <li>iOS ouvre le fichier : choisis <strong>Ajouter tout</strong>, puis un calendrier
            d&eacute;di&eacute; (cr&eacute;e-le une fois, nomm&eacute; &laquo;&nbsp;Planning&nbsp;&raquo;).</li>
          <li>Sur l&rsquo;&eacute;cran d&rsquo;accueil, appui long &rarr; <strong>+</strong> &rarr;
            widget <strong>Calendrier</strong>.</li>
        </ol>
        <p className="alert__hint">
          Le widget natif d&rsquo;Apple affiche alors ton planning. Une webapp ne peut pas cr&eacute;er
          son propre widget : iOS ne l&rsquo;autorise &agrave; aucun site.
        </p>
      </Alert>

      <div className="field">
        <span className="field__label">Contenu &agrave; exporter</span>
        <div className="btnrow">
          <button
            type="button"
            className={`btn${scope === 'me' ? ' btn--primary' : ''}`}
            onClick={() => setScope('me')}
            disabled={me === null}
          >
            Mon planning
          </button>
          <button
            type="button"
            className={`btn${scope === 'all' ? ' btn--primary' : ''}`}
            onClick={() => setScope('all')}
          >
            Toute l&rsquo;&eacute;quipe
          </button>
        </div>
        {me === null && (
          <p className="field__hint">
            Indique d&rsquo;abord qui tu es dans l&rsquo;onglet Coll&egrave;gues pour exporter ton
            seul planning.
          </p>
        )}
      </div>

      <label className="list-row" style={{ cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={includeNonWork}
          onChange={(event) => setIncludeNonWork(event.target.checked)}
        />
        <span className="list-row__body">
          <span className="list-row__title">Inclure repos et absences</span>
          <span className="list-row__sub">En &eacute;v&eacute;nements journ&eacute;e enti&egrave;re</span>
        </span>
      </label>

      <button
        type="button"
        className="btn btn--primary btn--block"
        style={{ marginTop: 16 }}
        onClick={() => void handleExport()}
        disabled={busy || people.length === 0}
      >
        {busy ? <span className="spinner" /> : 'Exporter vers le Calendrier (.ics)'}
      </button>

      {message !== null && <div style={{ marginTop: 12 }}><Alert tone="success">{message}</Alert></div>}

      <Alert tone="warn" title="R&eacute;exporter apr&egrave;s une mise &agrave; jour">
        <p className="alert__hint" style={{ margin: 0 }}>
          iOS ajoute les &eacute;v&eacute;nements sans remplacer les anciens. Pour &eacute;viter les
          doublons, supprime le calendrier &laquo;&nbsp;Planning&nbsp;&raquo; dans l&rsquo;app
          Calendrier avant de r&eacute;importer.
        </p>
      </Alert>

      <p className="section-title">Affichage</p>
      <div className="field">
        <label className="field__label" htmlFor="week-start">Premier jour de la semaine</label>
        <select
          id="week-start"
          className="select"
          value={settings.weekStartsOn}
          onChange={(event) => void updateSettings({ weekStartsOn: Number(event.target.value) === 0 ? 0 : 1 })}
        >
          <option value={1}>Lundi</option>
          <option value={0}>Dimanche</option>
        </select>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Donnees */

function DataSettings(): ReactNode {
  const { refresh } = usePlanning();
  const [imports, setImports] = useState<readonly ImportRecord[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reload = async (): Promise<void> => setImports(await listImports());

  useEffect(() => { void reload(); }, []);

  const handleUndo = async (id: string): Promise<void> => {
    const result = await undoImport(id);
    if (result.ok) setMessage(`${result.value} poste(s) retiré(s).`);
    await Promise.all([reload(), refresh()]);
  };

  const handleBackup = async (): Promise<void> => {
    const payload = await exportBackup();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `smart-planning-${payload.exportedAt.slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const handleRestore = async (file: File): Promise<void> => {
    try {
      const result = await importBackup(JSON.parse(await file.text()));
      setMessage(result.ok
        ? `${result.value} poste(s) restauré(s).`
        : result.error.message);
      await Promise.all([reload(), refresh()]);
    } catch {
      setMessage('Fichier de sauvegarde illisible.');
    }
  };

  return (
    <div>
      {message !== null && <Alert tone="success">{message}</Alert>}

      <p className="section-title">Historique des imports</p>
      {imports.length === 0 ? (
        <p className="muted small">Aucun import pour l&rsquo;instant.</p>
      ) : (
        imports.slice(0, 15).map((record) => (
          <div key={record.id} className="list-row">
            <span className="list-row__body">
              <span className="list-row__title">
                {record.sourceName || (record.sourceKind === 'pdf' ? 'PDF' : 'Photo')}
              </span>
              <span className="list-row__sub">
                {formatDateTime(record.createdAt)} &middot; +{record.diff.added} /
                ~{record.diff.updated} / &minus;{record.diff.removed}
              </span>
            </span>
            <button type="button" className="btn" onClick={() => void handleUndo(record.id)}>
              Annuler
            </button>
          </div>
        ))
      )}

      <p className="section-title">Sauvegarde</p>
      <p className="muted small" style={{ marginTop: 0 }}>
        Tes donn&eacute;es vivent uniquement dans ce navigateur. Efface l&rsquo;historique de
        Safari et elles disparaissent : garde une sauvegarde.
      </p>
      <div className="btnrow">
        <button type="button" className="btn" onClick={() => void handleBackup()}>
          T&eacute;l&eacute;charger une sauvegarde
        </button>
        <label className="btn">
          Restaurer
          <input
            type="file"
            accept="application/json"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void handleRestore(file);
            }}
          />
        </label>
      </div>

      <div className="divider" />

      {confirmClear ? (
        <Alert tone="error" title="Tout effacer ?">
          <p className="alert__hint">
            Plannings, coll&egrave;gues et historique seront supprim&eacute;s. Ta cl&eacute; API est
            conserv&eacute;e.
          </p>
          <div className="btnrow" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => void (async () => {
                await clearAllData();
                await Promise.all([reload(), refresh()]);
                setConfirmClear(false);
                setMessage('Données effacées.');
              })()}
            >
              Oui, tout effacer
            </button>
            <button type="button" className="btn" onClick={() => setConfirmClear(false)}>Annuler</button>
          </div>
        </Alert>
      ) : (
        <button type="button" className="btn btn--block" onClick={() => setConfirmClear(true)}>
          Effacer toutes les donn&eacute;es
        </button>
      )}
    </div>
  );
}

function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const readable = parseISODate(iso)?.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) ?? iso;
  return `${readable} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
