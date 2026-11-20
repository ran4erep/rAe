import React, { useState } from 'react';
import { Check, Plus, Trash2, X } from 'lucide-react';
import {
  AMIGA_CUSTOM_PICKER_GROUPS,
  CustomButtonSize,
  CustomButtonTarget,
  CustomControlButton,
  CustomControlProfile,
  CustomStickConfig,
  formatButtonTargetLabel,
  formatStickTargetLabel,
  STICK_KEY_OPTIONS,
  StickBindingTarget,
  StickDirection,
} from '../emulator/controls/customControls';
import { AMIGA_KEY_NAMES, AMIGA_RAW } from '../emulator/keyboard/amigaKeyMap';
import { CustomSelect, CustomSelectOption } from './CustomSelect';

interface StickEditorModalProps {
  stick: CustomStickConfig;
  onChangeStick: (next: CustomStickConfig) => void;
  onClose: () => void;
}

const DIR_META: Array<{ dir: StickDirection; title: string; glyph: string }> = [
  { dir: 'up', title: 'Вверх', glyph: '▲' },
  { dir: 'down', title: 'Вниз', glyph: '▼' },
  { dir: 'left', title: 'Влево', glyph: '◀' },
  { dir: 'right', title: 'Вправо', glyph: '▶' },
];

function serializeStickTarget(t: StickBindingTarget): string {
  if (t.kind === 'none') return 'none';
  if (t.kind === 'joy') return `joy:${t.dir}`;
  return `key:${t.rawCode}`;
}

function parseStickTarget(val: string): StickBindingTarget {
  if (val === 'none') return { kind: 'none' };
  if (val.startsWith('joy:')) {
    const dir = val.slice(4) as StickDirection;
    return { kind: 'joy', dir };
  }
  if (val.startsWith('key:')) {
    const code = Number(val.slice(4));
    if (Number.isInteger(code)) return { kind: 'key', rawCode: code };
  }
  return { kind: 'none' };
}

export const StickEditorModal: React.FC<StickEditorModalProps> = ({
  stick,
  onChangeStick,
  onClose,
}) => {
  const applyPreset = (preset: 'arrows' | 'wasd' | 'joy' | 'numpad') => {
    if (preset === 'arrows') {
      onChangeStick({
        ...stick,
        up: { kind: 'key', rawCode: AMIGA_RAW.UP },
        down: { kind: 'key', rawCode: AMIGA_RAW.DOWN },
        left: { kind: 'key', rawCode: AMIGA_RAW.LEFT },
        right: { kind: 'key', rawCode: AMIGA_RAW.RIGHT },
      });
    } else if (preset === 'wasd') {
      onChangeStick({
        ...stick,
        up: { kind: 'key', rawCode: AMIGA_RAW.W },
        down: { kind: 'key', rawCode: AMIGA_RAW.S },
        left: { kind: 'key', rawCode: AMIGA_RAW.A },
        right: { kind: 'key', rawCode: AMIGA_RAW.D },
      });
    } else if (preset === 'numpad') {
      onChangeStick({
        ...stick,
        up: { kind: 'key', rawCode: AMIGA_RAW.NP_8 },
        down: { kind: 'key', rawCode: AMIGA_RAW.NP_2 },
        left: { kind: 'key', rawCode: AMIGA_RAW.NP_4 },
        right: { kind: 'key', rawCode: AMIGA_RAW.NP_6 },
      });
    } else {
      onChangeStick({
        ...stick,
        up: { kind: 'joy', dir: 'up' },
        down: { kind: 'joy', dir: 'down' },
        left: { kind: 'joy', dir: 'left' },
        right: { kind: 'joy', dir: 'right' },
      });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-[2px] p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Настройка направлений стика"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full sm:max-w-md max-h-[85dvh] bg-[#1E2025] border-t sm:border border-white/15 rounded-t-2xl sm:rounded-xl flex flex-col overflow-hidden shadow-2xl">
        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-[#F2EFE9]">Настройка стика (▲ ▼ ◀ ▶)</h2>
            <p className="text-[11px] text-[#9E9A90]">Выберите, какую клавишу или джойстик передаёт каждая сторона</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть настройку стика"
            className="w-9 h-9 rounded-lg bg-[#2A2D33] hover:bg-[#353941] flex items-center justify-center text-[#E6E2D9]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {/* Quick presets */}
          <div className="space-y-1.5">
            <span className="text-[11px] font-semibold text-[#BDB9B0]">Быстрые шаблоны стика</span>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => applyPreset('arrows')}
                className="h-8 rounded-md bg-[#2A2D33] hover:bg-[#353941] text-xs font-semibold text-[#F2EFE9]"
              >
                Стрелки (↑↓←→)
              </button>
              <button
                type="button"
                onClick={() => applyPreset('wasd')}
                className="h-8 rounded-md bg-[#2A2D33] hover:bg-[#353941] text-xs font-semibold text-[#F2EFE9]"
              >
                WASD
              </button>
              <button
                type="button"
                onClick={() => applyPreset('joy')}
                className="h-8 rounded-md bg-[#2A2D33] hover:bg-[#353941] text-xs font-semibold text-[#F2EFE9]"
              >
                Джойстик (Port 2)
              </button>
              <button
                type="button"
                onClick={() => applyPreset('numpad')}
                className="h-8 rounded-md bg-[#2A2D33] hover:bg-[#353941] text-xs font-semibold text-[#F2EFE9]"
              >
                Numpad (8/2/4/6)
              </button>
            </div>
          </div>

          {/* Per-direction mapping */}
          <div className="space-y-2.5">
            {DIR_META.map(({ dir, title, glyph }) => {
              const current = stick[dir];
              const serialized = serializeStickTarget(current);
              const isCustomKeyNotInList =
                current.kind === 'key' && !STICK_KEY_OPTIONS.some((o) => o.rawCode === current.rawCode);

              const selectOptions: CustomSelectOption[] = [
                { value: 'none', label: 'Отключено (—)' },
                { value: 'joy:up', label: 'Джойстик Вверх (JOY ▲)', group: 'Джойстик Amiga (Port 2)' },
                { value: 'joy:down', label: 'Джойстик Вниз (JOY ▼)', group: 'Джойстик Amiga (Port 2)' },
                { value: 'joy:left', label: 'Джойстик Влево (JOY ◀)', group: 'Джойстик Amiga (Port 2)' },
                { value: 'joy:right', label: 'Джойстик Вправо (JOY ▶)', group: 'Джойстик Amiga (Port 2)' },
                ...(isCustomKeyNotInList && current.kind === 'key'
                  ? [
                      {
                        value: `key:${current.rawCode}`,
                        label: AMIGA_KEY_NAMES[current.rawCode] ?? formatStickTargetLabel(current),
                        group: 'Клавиши клавиатуры Amiga',
                      },
                    ]
                  : []),
                ...STICK_KEY_OPTIONS.map((opt) => ({
                  value: `key:${opt.rawCode}`,
                  label: opt.label,
                  group: 'Клавиши клавиатуры Amiga',
                })),
              ];

              return (
                <div key={dir} className="flex items-center gap-2.5 bg-[#15171B] border border-white/8 rounded-lg px-3 py-2">
                  <span className="w-6 text-center text-sm font-bold text-[#E07A22]">{glyph}</span>
                  <span className="w-16 text-xs font-semibold text-[#E6E2D9]">{title}</span>
                  <CustomSelect
                    ariaLabel={`Действие стика: ${title}`}
                    value={serialized}
                    options={selectOptions}
                    onChange={(val) => onChangeStick({ ...stick, [dir]: parseStickTarget(val) })}
                    size="md"
                    className="flex-1 bg-[#252830]"
                  />
                </div>
              );
            })}
          </div>

          {/* Stick Size & Visibility */}
          <div className="flex items-center justify-between gap-3 pt-2 border-t border-white/10">
            <span className="text-xs font-semibold text-[#D6D2C9]">Размер стика</span>
            <div className="flex gap-1 bg-[#121316] p-1 rounded-md">
              {(['sm', 'md', 'lg'] as CustomButtonSize[]).map((sz) => (
                <button
                  key={sz}
                  type="button"
                  onClick={() => onChangeStick({ ...stick, size: sz })}
                  className={`px-3 h-7 rounded text-xs font-semibold ${
                    stick.size === sz ? 'bg-[#C8342A] text-white' : 'text-[#BDB9B0] hover:text-white'
                  }`}
                >
                  {sz.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center justify-between gap-3 py-1 cursor-pointer">
            <span className="text-xs font-semibold text-[#D6D2C9]">Показывать стик на экране</span>
            <input
              type="checkbox"
              checked={stick.enabled}
              onChange={(e) => onChangeStick({ ...stick, enabled: e.target.checked })}
              className="w-5 h-5 accent-[#C8342A]"
            />
          </label>
        </div>

        <div className="px-4 py-3 border-t border-white/10 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 rounded-lg bg-[#C8342A] hover:bg-[#D94035] text-xs font-bold text-white flex items-center gap-1.5"
          >
            <Check className="w-4 h-4" />
            Применить
          </button>
        </div>
      </div>
    </div>
  );
};

interface ButtonEditorModalProps {
  button: CustomControlButton;
  onChangeButton: (next: CustomControlButton) => void;
  onDeleteButton: (id: string) => void;
  onClose: () => void;
}

function isTargetEqual(a: CustomButtonTarget, b: CustomButtonTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'key' && b.kind === 'key') return a.rawCode === b.rawCode;
  return true;
}

export const ButtonEditorModal: React.FC<ButtonEditorModalProps> = ({
  button,
  onChangeButton,
  onDeleteButton,
  onClose,
}) => {
  const [label, setLabel] = useState(button.label);

  const handleSelectTarget = (target: CustomButtonTarget) => {
    const defaultLabel = formatButtonTargetLabel(target).slice(0, 10);
    const shouldAutoUpdateLabel =
      label.trim() === '' || label === formatButtonTargetLabel(button.target).slice(0, 10);
    const nextLabel = shouldAutoUpdateLabel ? defaultLabel : label;
    setLabel(nextLabel);
    onChangeButton({ ...button, target, label: nextLabel });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-[2px] p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Настройка кнопки"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full sm:max-w-lg max-h-[88dvh] bg-[#1E2025] border-t sm:border border-white/15 rounded-t-2xl sm:rounded-xl flex flex-col overflow-hidden shadow-2xl">
        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold text-[#F2EFE9]">Настройка кнопки</h2>
            <p className="text-[11px] text-[#9E9A90]">
              Текущее действие: {formatButtonTargetLabel(button.target)}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onDeleteButton(button.id)}
              aria-label="Удалить кнопку"
              className="h-9 px-2.5 rounded-lg bg-[#3A2222] hover:bg-[#4D2A2A] text-[#FF9E98] text-xs font-semibold flex items-center gap-1"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Удалить
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Закрыть настройку кнопки"
              className="w-9 h-9 rounded-lg bg-[#2A2D33] hover:bg-[#353941] flex items-center justify-center text-[#E6E2D9]"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {/* Label & Size */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-[140px]">
              <label htmlFor="custom-btn-label" className="block text-[11px] font-semibold text-[#BDB9B0] mb-1">
                Текст на кнопке
              </label>
              <input
                id="custom-btn-label"
                type="text"
                maxLength={10}
                value={label}
                onChange={(e) => {
                  const val = e.target.value;
                  setLabel(val);
                  onChangeButton({ ...button, label: val.trim() ? val.slice(0, 10) : formatButtonTargetLabel(button.target).slice(0, 10) });
                }}
                className="w-full h-9 rounded-md bg-[#14161A] border border-white/12 px-2.5 text-xs text-[#F2EFE9] focus:outline-none focus:ring-1 focus:ring-[#E07A22]"
              />
            </div>

            <div>
              <span className="block text-[11px] font-semibold text-[#BDB9B0] mb-1">Размер</span>
              <div className="flex gap-1 bg-[#121316] p-1 rounded-md">
                {(['sm', 'md', 'lg'] as CustomButtonSize[]).map((sz) => (
                  <button
                    key={sz}
                    type="button"
                    onClick={() => onChangeButton({ ...button, size: sz })}
                    className={`px-3 h-7 rounded text-xs font-semibold ${
                      button.size === sz ? 'bg-[#C8342A] text-white' : 'text-[#BDB9B0] hover:text-white'
                    }`}
                  >
                    {sz.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Categorized Amiga Keys Picker */}
          <div className="space-y-3">
            {AMIGA_CUSTOM_PICKER_GROUPS.map((group) => (
              <div key={group.title} className="space-y-1.5">
                <h3 className="text-[11px] font-semibold text-[#9E9A90]">{group.title}</h3>
                <div className="flex flex-wrap gap-1.5">
                  {group.items.map((item) => {
                    const active = isTargetEqual(button.target, item.target);
                    return (
                      <button
                        key={item.label}
                        type="button"
                        onClick={() => handleSelectTarget(item.target)}
                        className={`h-8 px-2.5 rounded-md text-[11px] font-semibold border transition-colors ${
                          active
                            ? 'bg-[#C8342A] border-[#FF8E85]/60 text-white'
                            : 'bg-[#15171B] border-white/10 text-[#E6E2D9] hover:bg-[#262932]'
                        }`}
                      >
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="px-4 py-3 border-t border-white/10 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 rounded-lg bg-[#C8342A] hover:bg-[#D94035] text-xs font-bold text-white flex items-center gap-1.5"
          >
            <Check className="w-4 h-4" />
            Готово
          </button>
        </div>
      </div>
    </div>
  );
};

interface ProfileManagerModalProps {
  profiles: CustomControlProfile[];
  activeProfileId: string;
  onSelectProfile: (id: string) => void;
  onCreateProfile: (name: string) => void;
  onRenameProfile: (id: string, name: string) => void;
  onDeleteProfile: (id: string) => void;
  onClose: () => void;
}

export const ProfileManagerModal: React.FC<ProfileManagerModalProps> = ({
  profiles,
  activeProfileId,
  onSelectProfile,
  onCreateProfile,
  onRenameProfile,
  onDeleteProfile,
  onClose,
}) => {
  const active = profiles.find((p) => p.id === activeProfileId) ?? profiles[0];
  const [newName, setNewName] = useState('');
  const [editName, setEditName] = useState(active?.name ?? '');

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-[2px] p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Профили кастомного управления"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full sm:max-w-md max-h-[85dvh] bg-[#1E2025] border-t sm:border border-white/15 rounded-t-2xl sm:rounded-xl flex flex-col overflow-hidden shadow-2xl">
        <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-[#F2EFE9]">Профили управления</h2>
            <p className="text-[11px] text-[#9E9A90]">Сохраняются автоматически в кеше браузера</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть профили"
            className="w-9 h-9 rounded-lg bg-[#2A2D33] hover:bg-[#353941] flex items-center justify-center text-[#E6E2D9]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {/* Active profile list */}
          <div className="space-y-1.5">
            {profiles.map((p) => {
              const isSelected = p.id === activeProfileId;
              return (
                <div
                  key={p.id}
                  className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 ${
                    isSelected
                      ? 'bg-[#282B33] border-[#E07A22]/70'
                      : 'bg-[#15171B] border-white/8'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      onSelectProfile(p.id);
                      setEditName(p.name);
                    }}
                    className="flex-1 text-left min-w-0"
                  >
                    <div className="text-xs font-semibold text-[#F2EFE9] truncate">{p.name}</div>
                    <div className="text-[10px] text-[#8D8980]">
                      Кнопок: {p.buttons.length} · Стик: {formatStickTargetLabel(p.stick.up)}/{formatStickTargetLabel(p.stick.left)}/{formatStickTargetLabel(p.stick.down)}/{formatStickTargetLabel(p.stick.right)}
                    </div>
                  </button>
                  {profiles.length > 1 && (
                    <button
                      type="button"
                      onClick={() => onDeleteProfile(p.id)}
                      aria-label={`Удалить профиль ${p.name}`}
                      className="p-1.5 rounded hover:bg-[#3A2222] text-[#A7A39A] hover:text-[#FF9E98]"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Rename active profile */}
          {active && (
            <div className="space-y-1.5 pt-2 border-t border-white/10">
              <label htmlFor="rename-profile-input" className="block text-[11px] font-semibold text-[#BDB9B0]">
                Переименовать текущий профиль
              </label>
              <div className="flex gap-2">
                <input
                  id="rename-profile-input"
                  type="text"
                  maxLength={32}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="flex-1 h-9 rounded-md bg-[#14161A] border border-white/12 px-2.5 text-xs text-[#F2EFE9]"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (editName.trim()) onRenameProfile(active.id, editName.trim());
                  }}
                  className="h-9 px-3 rounded-md bg-[#2A2D33] hover:bg-[#353941] text-xs font-semibold text-[#F2EFE9]"
                >
                  Сохранить
                </button>
              </div>
            </div>
          )}

          {/* Create new profile */}
          <div className="space-y-1.5 pt-2 border-t border-white/10">
            <label htmlFor="new-profile-input" className="block text-[11px] font-semibold text-[#BDB9B0]">
              Создать новый профиль (на базе текущего)
            </label>
            <div className="flex gap-2">
              <input
                id="new-profile-input"
                type="text"
                maxLength={32}
                placeholder="Например: Turrican II"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="flex-1 h-9 rounded-md bg-[#14161A] border border-white/12 px-2.5 text-xs text-[#F2EFE9]"
              />
              <button
                type="button"
                onClick={() => {
                  const title = newName.trim() || `Профиль ${profiles.length + 1}`;
                  onCreateProfile(title);
                  setNewName('');
                  setEditName(title);
                }}
                className="h-9 px-3 rounded-md bg-[#C8342A] hover:bg-[#D94035] text-xs font-bold text-white flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" />
                Создать
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
