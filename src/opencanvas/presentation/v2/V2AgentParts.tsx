import { Fragment, useEffect, useRef, useState } from 'react';
import {
  IconAlertTriangle, IconArrowLeft, IconBook, IconCheck, IconCopy, IconEye, IconIcons, IconListDetails, IconPencil, IconPhotoOff,
  IconPlus, IconSparkles, IconTarget, IconTrash, type Icon as TablerIcon,
} from '@tabler/icons-react';
import { Button, Icon, IconButton } from '../design-system';
import type { AgentStep } from '../../application/ai/assistantAgent';
import { parseMarkdown, type MdInline } from './assistantMarkdown';
import type { ChatImage, ChatMessage, useV2Assistant } from './useV2Assistant';

const ACTIVITY: Record<string, string> = {
  building: 'Laying out the diagram', fixing: 'Fixing a syntax error', drafting: 'Drawing the diagram',
};
// ponytail: timed labels, not real progress; the provider reports no stages before the first token.
const WAITING = ['Reading the page', 'Thinking', 'Writing'] as const;
const WAITING_BLANK = ['Thinking', 'Writing'] as const;

/**
 * The OpenFlowKit mark as a line drawing: two nodes and the flow between them.
 * Reading, the nodes pulse; otherwise the flow draws from one node to the
 * other and loops. Still (and without motion) it rests fully drawn.
 */
function FlowMark({ stage }: { readonly stage: 'read' | 'draw' | 'still' }) {
  return (
    <svg className="ofk-v2-flow-mark" data-stage={stage} viewBox="8 8 24 24" aria-hidden="true">
      <path pathLength={1} d="M14.5 14.4 L10.6 21.3 C9.4 23.4 11.9 26.4 14.2 24.6 L25.8 14.6 C28.1 12.8 30.6 15.8 29.4 17.9 L25.5 25.5" />
      <circle cx="14.5" cy="14.4" r="3.4" />
      <circle cx="25.5" cy="25.5" r="3.4" />
    </svg>
  );
}

/** The mark, shimmering label, three dots. While waiting, the label walks the stages. */
export function Activity({ phase, reading }: { readonly phase: string; readonly reading: boolean }) {
  const [step, setStep] = useState(0);
  const steps = reading ? WAITING : WAITING_BLANK;
  useEffect(() => {
    if (phase !== 'waiting') return undefined;
    const timer = setInterval(() => setStep((current) => Math.min(current + 1, steps.length - 1)), 1600);
    return () => clearInterval(timer);
  }, [phase, steps.length]);
  const label = phase === 'waiting' ? steps[Math.min(step, steps.length - 1)] : ACTIVITY[phase];
  return (
    <p className="ofk-v2-activity" role="status">
      <span className="ofk-v2-activity-mark" aria-hidden="true"><FlowMark stage={label === 'Reading the page' ? 'read' : 'draw'} /></span>
      <span key={label} className="ofk-v2-shimmer">{label}</span>
      <span className="ofk-v2-dots" aria-hidden="true"><i /><i /><i /></span>
    </p>
  );
}

function Inline({ parts }: { readonly parts: readonly MdInline[] }) {
  return <>{parts.map((part, index) => {
    if (part.kind === 'code') return <code key={index}>{part.text}</code>;
    if (part.kind === 'strong') return <strong key={index}>{part.text}</strong>;
    if (part.kind === 'em') return <em key={index}>{part.text}</em>;
    if (part.kind === 'link') return <a key={index} href={part.href} target="_blank" rel="noreferrer noopener">{part.text}</a>;
    return <Fragment key={index}>{part.text}</Fragment>;
  })}</>;
}

export function Markdown({ text }: { readonly text: string }) {
  return <div className="ofk-v2-md">{parseMarkdown(text).map((block, index) => {
    switch (block.kind) {
      case 'pre': return <pre key={index}><code>{block.text}</code></pre>;
      case 'h': return <h4 key={index} data-level={block.level}><Inline parts={block.inline} /></h4>;
      case 'ul': return <ul key={index}>{block.items.map((item, i) => <li key={i}><Inline parts={item} /></li>)}</ul>;
      case 'ol': return <ol key={index}>{block.items.map((item, i) => <li key={i}><Inline parts={item} /></li>)}</ol>;
      default: return <p key={index}>{block.lines.map((line, i) => <Fragment key={i}>{i ? <br /> : null}<Inline parts={line} /></Fragment>)}</p>;
    }
  })}</div>;
}

export function CopyButton({ text, label = 'Copy' }: { readonly text: string; readonly label?: string }) {
  const [copied, setCopied] = useState<'Copied' | 'Copy failed' | null>(null);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(null), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  return <IconButton variant="quiet" label={copied ?? label}
    icon={<Icon icon={copied === 'Copied' ? IconCheck : copied ? IconAlertTriangle : IconCopy} />}
    onClick={() => {
      // No clipboard (http, an iframe) or a refused permission: say so, not nothing.
      (navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('no clipboard')))
        .then(() => setCopied('Copied'), () => setCopied('Copy failed'));
    }} />;
}

export function Thinking({ message, live: streaming }: { readonly message: ChatMessage; readonly live: boolean }) {
  if (!message.thinking) return null;
  // Live only until the reply moves on: to text, or to its first tool step.
  const live = streaming && !message.steps?.length;
  const seconds = message.thoughtMs ? Math.max(1, Math.round(message.thoughtMs / 1000)) : 0;
  return (
    <details className="ofk-v2-thinking" open={live && !message.text ? true : undefined}>
      <summary data-live={live && !message.text ? '' : undefined}>
        <span className="ofk-v2-activity-mark" data-still={live && !message.text ? undefined : ''} aria-hidden="true">
          <FlowMark stage={live && !message.text ? 'draw' : 'still'} />
        </span>{live && !message.text ? <span className="ofk-v2-shimmer">Thinking…</span> : seconds ? `Thought for ${seconds}s` : 'Thoughts'}
      </summary>
      <div className="ofk-v2-thinking-body"><Markdown text={message.thinking} /></div>
    </details>
  );
}

const STEP_ICONS: Record<string, TablerIcon> = {
  list_diagrams: IconListDetails, read_diagram: IconEye, get_syntax: IconBook,
  find_icons: IconIcons, update_diagram: IconPencil, add_diagram: IconPlus,
};

/** The agent's tool calls: open while it works, one summary line once done. */
export function Steps({ steps, live }: { readonly steps: readonly AgentStep[] | undefined; readonly live: boolean }) {
  if (!steps?.length) return null;
  const running = steps.find(({ status }) => status === 'running');
  const tools = steps.filter(({ tool }) => tool !== 'note');
  const failed = tools.filter(({ status }) => status === 'error').length;
  const summary = live && running ? `${running.label}…`
    : `${tools.length} ${tools.length === 1 ? 'step' : 'steps'}${failed ? ` · ${failed} retried` : ''}`;
  return (
    <details className="ofk-v2-steps" open={live || undefined}>
      <summary data-live={live && running ? '' : undefined}>
        <Icon icon={IconListDetails} />{live && running ? <span className="ofk-v2-shimmer">{summary}</span> : summary}
      </summary>
      <ol>
        {steps.map((step) => (step.tool === 'note'
          ? <li key={step.id} data-note=""><span className="ofk-v2-step-label"><Markdown text={step.label} /></span></li>
          : <li key={step.id} data-status={step.status}>
            <Icon icon={STEP_ICONS[step.tool] ?? IconSparkles} />
            <span className="ofk-v2-step-label">{step.label}</span>
            {step.detail ? <span className="ofk-v2-step-detail">{step.detail}</span> : null}
            <span className="ofk-v2-step-state" aria-label={step.status === 'running' ? 'Running' : step.status === 'error' ? 'Needed a fix' : 'Done'}>
              {step.status === 'running' ? <i /> : <Icon icon={step.status === 'error' ? IconAlertTriangle : IconCheck} />}
            </span>
          </li>))}
      </ol>
    </details>
  );
}

export const imageUrl = ({ mediaType, data }: ChatImage): string => `data:${mediaType};base64,${data}`;

/** Images on a sent turn; one dropped to fit storage shows as a placeholder. */
export function TurnImages({ images }: { readonly images: readonly ChatImage[] | undefined }) {
  if (!images?.length) return null;
  return (
    <div className="ofk-v2-turn-images">
      {images.map((image, index) => (image.data
        ? <img key={index} src={imageUrl(image)} alt={image.name || 'Attached image'} title={image.name} />
        : <span key={index} className="ofk-v2-image-gone" title="Not kept on this device to save space">
          <Icon icon={IconPhotoOff} />{image.name || 'Image'}
        </span>))}
    </div>
  );
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function ago(time: number, now = Date.now()): string {
  const minutes = Math.round((time - now) / 60_000);
  if (Math.abs(minutes) < 1) return 'just now';
  if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return RELATIVE.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return RELATIVE.format(days, 'day');
  return new Date(time).toLocaleDateString();
}

/** Past chats for this document: open one, or delete it (a second click confirms). */
export function ChatHistory({ chats, activeId, onOpen, onDelete, onClose }: {
  readonly chats: ReturnType<typeof useV2Assistant>['chats'];
  readonly activeId: string;
  readonly onOpen: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onClose: () => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus(); }, []);
  return (
    <nav className="ofk-v2-history" aria-label="Chats in this document"
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
      <header>
        <button ref={back} type="button" className="ofk-v2-history-back" onClick={onClose}>
          <Icon icon={IconArrowLeft} />Back to chat
        </button>
        <span>{chats.length} {chats.length === 1 ? 'chat' : 'chats'} in this document</span>
      </header>
      {chats.length ? <ul>
        {chats.map((chat) => (
          <li key={chat.id} data-active={chat.id === activeId || undefined}>
            <button type="button" className="ofk-v2-history-open" onClick={() => onOpen(chat.id)}
              aria-current={chat.id === activeId ? 'true' : undefined}>
              <span className="ofk-v2-history-title">{chat.title}</span>
              <span className="ofk-v2-history-meta">
                {chat.id === activeId ? 'Open · ' : ''}{ago(chat.updatedAt)} · {chat.count} {chat.count === 1 ? 'message' : 'messages'}
              </span>
            </button>
            {confirming === chat.id
              ? <Button variant="quiet" className="ofk-v2-history-confirm" autoFocus aria-label={`Confirm delete “${chat.title}”`} onClick={() => { setConfirming(null); onDelete(chat.id); }}
                onBlur={() => setConfirming(null)}>Delete</Button>
              : <IconButton variant="quiet" label={`Delete “${chat.title}”`} icon={<Icon icon={IconTrash} />}
                onClick={() => setConfirming(chat.id)} />}
          </li>
        ))}
      </ul> : <p className="ofk-v2-outcome">No chats yet. What you ask here is kept on this device, per document.</p>}
    </nav>
  );
}

/** Mounts per edit, so the draft always starts from the sent text. */
export function EditTurn({ text, images, busy, onCancel, onResend }: {
  readonly text: string; readonly images: boolean; readonly busy: boolean; readonly onCancel: () => void; readonly onResend: (text: string) => void;
}) {
  const [draft, setDraft] = useState(text);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { field.current?.focus(); field.current?.select(); }, []);
  return (
    <div className="ofk-v2-edit">
      <textarea ref={field} aria-label="Edit message" rows={2} value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); onResend(draft); }
          if (event.key === 'Escape') { event.stopPropagation(); onCancel(); }
        }} />
      <div>
        <span>Sending again replaces the replies below.</span>
        <Button variant="quiet" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={(!draft.trim() && !images) || busy} onClick={() => onResend(draft)}>Send</Button>
      </div>
    </div>
  );
}

export function UserTurn({ message, busy, editing, onEdit, onCancel, onResend }: {
  readonly message: ChatMessage; readonly busy: boolean; readonly editing: boolean;
  readonly onEdit: () => void; readonly onCancel: () => void; readonly onResend: (text: string) => void;
}) {
  if (editing) return <EditTurn text={message.text} images={Boolean(message.images?.length)} busy={busy} onCancel={onCancel} onResend={onResend} />;
  return <>
    <TurnImages images={message.images} />
    {message.text ? <p className="ofk-v2-user-text">{message.text}</p> : null}
    <div className="ofk-v2-message-actions">
      {message.scope === 'selection' ? <span className="ofk-v2-scope-tag"><Icon icon={IconTarget} />Selection</span> : null}
      <CopyButton text={message.text} />
      <IconButton variant="quiet" label="Edit message" disabled={busy} icon={<Icon icon={IconPencil} />} onClick={onEdit} />
    </div>
  </>;
}
