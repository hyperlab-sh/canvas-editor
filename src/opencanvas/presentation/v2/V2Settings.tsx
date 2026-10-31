import { useId, useState, type RefObject } from 'react';
import { setUsageSwitch, usageSwitchOn } from '../../../services/usage/usage';
import { Popover, PopoverHeader, Segmented, Switch } from '../design-system';
import type { V2Density, V2Preferences, V2ThemePreference } from './useV2Preferences';
import { V2PanelField } from './V2PanelField';
import { COMMAND } from './v2Shortcuts';

export interface V2SettingsProps {
  preferences: V2Preferences;
  canvasDefaultColor: string;
  onPreferencesChange: (patch: Partial<V2Preferences>) => void;
}

export function V2Settings({ open, anchorRef, onClose, preferences, onPreferencesChange }:
  V2SettingsProps & { open: boolean; anchorRef: RefObject<HTMLButtonElement | null>; onClose: () => void }): React.JSX.Element {
  const id = useId();
  // Not a preference: it lives with the counter, which reads it on every count.
  const [stats, setStats] = useState(usageSwitchOn);
  return (
    <Popover role="dialog" aria-label="Settings" open={open} anchorRef={anchorRef} onClose={onClose} placement="bottom-start">
      <PopoverHeader title="Settings" onClose={onClose} />
      <div className="ofk-v2-properties ofk-v2-settings">
        <section className="ofk-v2-panel-section" aria-label="Appearance">
          <h3>Appearance</h3>
          <V2PanelField label="Theme">
            <Segmented<V2ThemePreference> label="Appearance" value={preferences.theme}
              onChange={(theme) => onPreferencesChange({ theme })}
              options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' }]} />
          </V2PanelField>
          <V2PanelField label="Interface density">
            <Segmented<V2Density> label="Density" value={preferences.density}
              onChange={(density) => onPreferencesChange({ density })}
              options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
          </V2PanelField>
        </section>
        <section className="ofk-v2-panel-section" aria-label="Canvas">
          <h3>Canvas</h3>
          <Switch label="Dot grid" checked={preferences.showGrid} onChange={(event) => onPreferencesChange({ showGrid: event.target.checked })} />
          <div className="ofk-v2-setting-row">
            <Switch label="Snap to grid" aria-describedby={`${id}-snap`} checked={preferences.snapToGrid} onChange={(event) => onPreferencesChange({ snapToGrid: event.target.checked })} />
            <p id={`${id}-snap`} className="ofk-caption">Hold {COMMAND()} while dragging to move freely.</p>
          </div>
        </section>
        <section className="ofk-v2-panel-section" aria-label="Diagrams">
          <h3>Diagrams</h3>
          <div className="ofk-v2-setting-row">
            <Switch label="Icons from labels" aria-describedby={`${id}-icons`} checked={preferences.autoIcons} onChange={(event) => onPreferencesChange({ autoIcons: event.target.checked })} />
            <p id={`${id}-icons`} className="ofk-caption">Add matching logos when generating diagrams. Explicit icon settings take priority.</p>
          </div>
        </section>
        <section className="ofk-v2-panel-section" aria-label="Privacy">
          <h3>Privacy</h3>
          <div className="ofk-v2-setting-row">
            <Switch label="Share usage stats" aria-describedby={`${id}-stats`} checked={stats}
              onChange={(event) => { setUsageSwitch(event.target.checked); setStats(event.target.checked); }} />
            <p id={`${id}-stats`} className="ofk-caption">Helps us improve OpenFlowKit. Your diagrams stay on your device.</p>
          </div>
        </section>

      </div>
    </Popover>
  );
}
