import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { IconArrowUp, IconCheck, IconDots, IconPencil, IconSparkles, IconTrash, IconX } from '@tabler/icons-react';
import type { SceneCommentMessage, SceneCommentThread } from '../../domain/document/types';
import { COMMENT_BODY_MAX } from '../../domain/document/types';
import { Button, Icon, IconButton, Menu, MenuItem } from '../design-system';
import { DISPLAY_NAME_MAX } from './useV2Preferences';
import { V2LiveCommentsToggle } from './V2LiveCommentsToggle';
import { avatarColor, initialOf, relativeTime } from './v2CommentsView';

// Keys typed into a comment belong to the comment: they never reach the editor's shortcuts.
export const keep = (event: KeyboardEvent): void => event.stopPropagation();

export function Avatar({ kind, name, size = 24 }: { readonly kind: 'human' | 'agent'; readonly name: string; readonly size?: number }): React.JSX.Element {
  return kind === 'agent'
    ? <span className="ofk-comment-avatar" data-kind="agent" style={{ width: size, height: size }} aria-hidden="true"><Icon icon={IconSparkles} /></span>
    : <span className="ofk-comment-avatar" style={{ width: size, height: size, background: avatarColor(name) }} aria-hidden="true">{initialOf(name)}</span>;
}

/** Enter sends, Shift+Enter breaks a line, Esc leaves; the box grows with its text. */
export function CommentInput(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;
  readonly onEscape?: () => void;
  readonly placeholder: string;
  readonly label: string;
  readonly autoFocus?: boolean;
  readonly selectOnFocus?: boolean;
  readonly sendLabel?: string;
}): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);
  // After the opening click has finished moving focus (the canvas takes it on pointerdown).
  useEffect(() => {
    if (!props.autoFocus) return;
    const frame = requestAnimationFrame(() => {
      const box = ref.current;
      if (!box) return;
      box.focus({ preventScroll: true });
      if (props.selectOnFocus) box.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [props.autoFocus, props.selectOnFocus]);
  const empty = props.value.trim() === '';
  return (
    <div className="ofk-comment-input">
      <textarea ref={ref} rows={1} value={props.value} maxLength={COMMENT_BODY_MAX} placeholder={props.placeholder} aria-label={props.label}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          keep(event);
          if (event.key === 'Escape') { event.preventDefault(); props.onEscape?.(); return; }
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (!empty) props.onSend();
          }
        }} />
      <button type="button" className="ofk-comment-send" disabled={empty} aria-label={props.sendLabel ?? 'Send comment'} onClick={props.onSend}>
        <Icon icon={IconArrowUp} />
      </button>
    </div>
  );
}

/** Asked once, the first time someone writes: the name their comments carry. */
export function NameGate(props: { readonly onName: (name: string) => void; readonly onEscape?: () => void }): React.JSX.Element {
  const [name, setName] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);
  const save = () => { if (name.trim()) props.onName(name.trim()); };
  return (
    <div className="ofk-comment-name">
      <label>
        <span>Your name, shown on comments</span>
        <input ref={ref} value={name} maxLength={DISPLAY_NAME_MAX} placeholder="Name" onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            keep(event);
            if (event.key === 'Escape') { event.preventDefault(); props.onEscape?.(); }
            else if (event.key === 'Enter') { event.preventDefault(); save(); }
          }} />
      </label>
      <Button variant="primary" disabled={!name.trim()} onClick={save}>Continue</Button>
    </div>
  );
}

interface Live { readonly on: boolean; readonly available: boolean; readonly onChange: (on: boolean) => void }

/** A new thread's opening box, next to the ghost pin. */
export function CommentComposer(props: {
  readonly name: string;
  readonly live: Live;
  readonly onName: (name: string) => void;
  readonly onSend: (body: string) => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const [body, setBody] = useState('');
  return (
    <div className="ofk-comment-card ofk-comment-composer" role="dialog" aria-label="New comment" data-comment-ui data-comment-open
      onKeyDown={keep}>
      {props.name ? (
        <>
          <CommentInput value={body} onChange={setBody} onSend={() => props.onSend(body)} onEscape={props.onCancel}
            placeholder="Add a comment" label="Comment" autoFocus />
          <V2LiveCommentsToggle compact on={props.live.on} available={props.live.available} onChange={props.live.onChange} />
        </>
      ) : <NameGate onName={props.onName} onEscape={props.onCancel} />}
    </div>
  );
}

function MessageMenu(props: { readonly label: string; readonly onEdit: () => void; readonly onDelete: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton ref={anchor} variant="quiet" label={props.label} aria-haspopup="menu" aria-expanded={open}
        icon={<Icon icon={IconDots} />} onClick={() => setOpen((on) => !on)} />
      <Menu open={open} anchorRef={anchor} onClose={() => setOpen(false)} label={props.label} placement="bottom-end">
        <MenuItem icon={<Icon icon={IconPencil} />} onSelect={props.onEdit}>Edit</MenuItem>
        <MenuItem icon={<Icon icon={IconTrash} />} danger onSelect={props.onDelete}>Delete</MenuItem>
      </Menu>
    </>
  );
}

function Message(props: {
  readonly message: SceneCommentMessage;
  readonly canEdit: boolean;
  readonly now: number;
  readonly onEdit: (body: string) => void;
  readonly onDelete: () => void;
}): React.JSX.Element {
  const { message } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const commit = () => { if (draft.trim()) { props.onEdit(draft); setEditing(false); } };
  return (
    <li className="ofk-comment-message" data-testid="v2-comment-message">
      <Avatar kind={message.author.kind} name={message.author.name} />
      <div>
        <p className="ofk-comment-meta">
          <strong>{message.author.name}</strong>
          <time dateTime={message.createdAt}>{relativeTime(message.createdAt, props.now)}</time>
          {message.editedAt ? <span>edited</span> : null}
        </p>
        {editing ? (
          <div className="ofk-comment-edit">
            <CommentInput value={draft} onChange={setDraft} onSend={commit} onEscape={() => { setEditing(false); setDraft(message.body); }}
              placeholder="Edit comment" label="Edit comment" sendLabel="Save comment" autoFocus selectOnFocus />
          </div>
        ) : <p className="ofk-comment-body">{message.body}</p>}
      </div>
      {props.canEdit && !editing ? (
        <MessageMenu label="Comment actions" onEdit={() => { setDraft(message.body); setEditing(true); }} onDelete={props.onDelete} />
      ) : null}
    </li>
  );
}

/** A thread: its messages, a reply box, and resolve / delete. Read-only shows the conversation and nothing to change. */
export function ThreadPopover(props: {
  readonly thread: SceneCommentThread;
  readonly readOnly: boolean;
  readonly name: string;
  readonly live: Live;
  readonly onName: (name: string) => void;
  readonly onClose: () => void;
  readonly onResolve: () => void;
  readonly onDeleteThread: () => void;
  readonly onReply: (body: string) => void;
  readonly onEditMessage: (messageId: string, body: string) => void;
  readonly onDeleteMessage: (messageId: string) => void;
  readonly now: number;
}): React.JSX.Element {
  const { thread, readOnly } = props;
  const [reply, setReply] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  // 'thread' is also what deleting the opening message means.
  const [confirming, setConfirming] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const count = thread.messages.length;
  useLayoutEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [count]);
  const first = thread.messages[0]?.id;
  let body: ReactNode = null;
  if (confirming) {
    body = (
      <div className="ofk-comment-confirm" role="alert">
        <p>Delete this thread{count > 1 ? ` and its ${count} messages` : ''}?</p>
        <div>
          <Button variant="danger" autoFocus onClick={() => { setConfirming(false); props.onDeleteThread(); }}>Delete thread</Button>
          <Button variant="quiet" onClick={() => setConfirming(false)}>Cancel</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="ofk-comment-card ofk-comment-thread" role="dialog" aria-label="Comment thread" data-comment-ui data-comment-open
      data-testid="v2-comment-thread"
      onKeyDown={(event) => {
        keep(event);
        // The menu, and a box with its own Escape, handle theirs.
        if (event.key === 'Escape' && !event.defaultPrevented && !(event.target as Element).closest('[role="menu"]')) { event.preventDefault(); props.onClose(); }
      }}>
      <header>
        <h3>Comment</h3>
        {readOnly ? null : (
          <>
            <IconButton ref={menuAnchor} variant="quiet" label="Thread actions" aria-haspopup="menu" aria-expanded={menuOpen}
              icon={<Icon icon={IconDots} />} onClick={() => setMenuOpen((open) => !open)} />
            <Menu open={menuOpen} anchorRef={menuAnchor} onClose={() => setMenuOpen(false)} label="Thread actions" placement="bottom-end">
              <MenuItem icon={<Icon icon={IconTrash} />} danger onSelect={() => setConfirming(true)}>Delete thread…</MenuItem>
            </Menu>
            <IconButton variant="quiet" label="Resolve thread" icon={<Icon icon={IconCheck} />} onClick={props.onResolve} />
          </>
        )}
        <IconButton variant="quiet" label="Close thread" icon={<Icon icon={IconX} />} onClick={props.onClose} />
      </header>
      {body}
      <ul ref={listRef} className="ofk-comment-messages">
        {thread.messages.map((message) => (
          <Message key={message.id} message={message} now={props.now}
            canEdit={!readOnly && message.author.kind === 'human'}
            onEdit={(text) => props.onEditMessage(message.id, text)}
            onDelete={() => (message.id === first ? setConfirming(true) : props.onDeleteMessage(message.id))} />
        ))}
      </ul>
      {readOnly ? null : (
        <footer>
          {props.name ? (
            <>
              <CommentInput value={reply} onChange={setReply} placeholder="Reply" label="Reply" sendLabel="Send reply"
                onSend={() => { props.onReply(reply); setReply(''); }} onEscape={props.onClose} />
              <V2LiveCommentsToggle compact on={props.live.on} available={props.live.available} onChange={props.live.onChange} />
            </>
          ) : <NameGate onName={props.onName} onEscape={props.onClose} />}
        </footer>
      )}
    </div>
  );
}
