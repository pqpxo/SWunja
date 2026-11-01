import { useState } from 'react';
import {
  Activity, Battery, Bell, BookOpen, Bot, Box, Briefcase, Camera, Car, CircuitBoard, Cloud, Code, Container, Cpu, Database,
  Film, FlaskConical, Folder, Gamepad2, Globe, Hammer, HardDrive, Heart, House, Key, Layers, Leaf, Lightbulb, Lock, Microchip,
  Monitor, Music, Network, Package, Plug, Printer, Radio, Rocket, Router, Server, Shield, Smartphone, Speaker, Star, Terminal,
  Thermometer, Tv, Upload, Wifi, Wrench, Zap, type LucideIcon,
} from 'lucide-react';
import { upload } from './api';
import { Menu } from './ui';

// Icon names stored on projects; picked for homelab work (hosts, devices, code, home automation, electronics).
export const ICONS: Record<string, LucideIcon> = {
  server: Server, cpu: Cpu, 'hard-drive': HardDrive, database: Database, cloud: Cloud, container: Container, router: Router,
  wifi: Wifi, network: Network, globe: Globe, shield: Shield, lock: Lock, key: Key, terminal: Terminal, code: Code,
  package: Package, box: Box, layers: Layers, house: House, lightbulb: Lightbulb, thermometer: Thermometer, camera: Camera,
  plug: Plug, zap: Zap, battery: Battery, 'circuit-board': CircuitBoard, microchip: Microchip, radio: Radio, bot: Bot,
  monitor: Monitor, tv: Tv, smartphone: Smartphone, speaker: Speaker, printer: Printer, wrench: Wrench, hammer: Hammer,
  rocket: Rocket, flask: FlaskConical, activity: Activity, bell: Bell, gamepad: Gamepad2, music: Music, film: Film,
  book: BookOpen, briefcase: Briefcase, car: Car, leaf: Leaf, heart: Heart, star: Star, folder: Folder,
};

/** Project icon tinted with the project colour; falls back to the colour dot. Unknown values render as text (emoji). */
export function ProjectIcon({ icon, color, size = 16 }: { icon: string; color: string; size?: number }) {
  const c = color || 'var(--faint)';
  if (!icon) return <span className="dot" style={{ background: c }} aria-hidden />;
  const img = /^img:(\d+)$/.exec(icon);
  if (img) return <img className="p-img" src={`/api/attachments/${img[1]}`} width={size} height={size} alt="" aria-hidden />;
  const I = ICONS[icon];
  if (I) return <I size={size} color={c} strokeWidth={2.2} aria-hidden className="p-icon" />;
  return <span className="p-emoji" style={{ fontSize: size * .95 }} aria-hidden>{icon}</span>;
}

export function IconPicker({ icon, color, onChange }: { icon: string; color: string; onChange: (patch: { icon?: string; color?: string }) => void }) {
  const [emoji, setEmoji] = useState(ICONS[icon] || icon.startsWith('img:') ? '' : icon);
  const [err, setErr] = useState('');
  const uploadIcon = async (f: File | undefined) => {
    if (!f) return;
    setErr('');
    if (!/^image\/(png|jpe?g|gif|webp|avif)$/.test(f.type)) return setErr('Use a PNG, JPEG, GIF, WebP or AVIF image.');
    if (f.size > 2 * 1024 * 1024) return setErr('Keep icons under 2 MB.');
    try {
      const a = await upload(f);
      onChange({ icon: `img:${a.id}` });
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Menu className="icon-picker" ariaLabel="Project icon and colour" label={<ProjectIcon icon={icon} color={color} size={20} />}>
      <div className="picker-row">
        <span className="picker-label">Colour</span>
        <input type="color" className="swatch" aria-label="Project colour" value={color || '#8b8fa3'} onChange={e => onChange({ color: e.target.value })} />
      </div>
      <div className="icon-grid" role="listbox" aria-label="Project icon">
        {Object.entries(ICONS).map(([name, I]) => (
          <button key={name} role="option" aria-selected={icon === name} className={`icon-cell ${icon === name ? 'on' : ''}`} title={name} onClick={() => onChange({ icon: name })}>
            <I size={17} />
          </button>
        ))}
      </div>
      <label className={`upload-icon ${icon.startsWith('img:') ? 'on' : ''}`}>
        {icon.startsWith('img:') ? <ProjectIcon icon={icon} color={color} size={22} /> : <Upload size={15} />}
        {icon.startsWith('img:') ? 'Replace Image' : 'Upload Image'}
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" hidden onChange={e => { uploadIcon(e.target.files?.[0]); e.target.value = ''; }} />
      </label>
      {err && <p className="error">{err}</p>}
      <div className="picker-row">
        <input className="emoji-input" placeholder="or an emoji 🏠" aria-label="Emoji icon" maxLength={8} value={emoji}
          onChange={e => setEmoji(e.target.value)} onKeyDown={e => e.key === 'Enter' && emoji.trim() && onChange({ icon: emoji.trim() })} />
        <button onClick={() => emoji.trim() && onChange({ icon: emoji.trim() })}>Use</button>
      </div>
      <button onClick={() => { setEmoji(''); onChange({ icon: '' }); }}>No Icon (Colour Dot)</button>
    </Menu>
  );
}
