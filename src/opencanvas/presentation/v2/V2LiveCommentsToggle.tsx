import { Switch } from '../design-system';

/**
 * Live comments: each new comment of yours is pushed into the connected agent's session. It needs the agent
 * bridge, so without one the switch is off and says why.
 */
export function V2LiveCommentsToggle(props: {
  readonly on: boolean;
  readonly available: boolean;
  readonly onChange: (on: boolean) => void;
  readonly compact?: boolean;
}): React.JSX.Element {
  const why = props.available ? null : 'Connect an agent first: live comments are sent through the agent connection.';
  return (
    <div className="ofk-comment-live" data-compact={props.compact || undefined} title={why ?? undefined}>
      <Switch label="Live comments" checked={props.on && props.available} disabled={!props.available}
        onChange={(event) => props.onChange(event.target.checked)} />
      {props.compact ? null : (
        <p>{why ?? 'Your agent hears each new comment as you write it. Off, it only reads them when you ask.'}</p>
      )}
    </div>
  );
}
