import React, { useState } from 'react';
import { Check, Gamepad2, Keyboard, MousePointer, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  ControlButtonSize,
  CustomControlProfile,
  CustomProfilesState,
  getTargetDisplayLabel,
  StickDirection,
} from '../emulator/controls/customProfiles';
import { CustomSelect } from './CustomSelect';

export type CustomSelection =
  | { kind: 'button'; id: string }
  | { kind: 'stick' }
  | null;

interface CustomEditToolbarProps {
  profilesState: CustomProfilesState;
  activeProfile: CustomControlProfile;
  selection: CustomSelection;
  onSelectProfile: (profileId: string) => void;
  onCreateProfile: (name: string) => void;
  onRenameProfile: (name: string) => void;
  onDeleteProfile: () => void;
  onAddButton: () => void;
  onAddMouseButton: (button: 'left' | 'right') => void;
  onAddStick: () => void;
  onDeleteSelected: () => void;
  onOpenButtonPicker: (buttonId: string) => void;
  onOpenStickDirPicker: (dir: StickDirection) => void;
  onChangeSelectedSize: (size: ControlButtonSize) => void;
  onDone: () => void;
  fullscreenOverlay?: boolean;
}

export const CustomEditToolbar: React.FC<CustomEditToolbarProps> = ({
  profilesState,
  activeProfile,
  selection,
  onSelectProfile,
  onCreateProfile,
  onRenameProfile,
  onDeleteProfile,
  onAddButton,
  onAddMouseButton,
  onAddStick,
  onDeleteSelected,
  onOpenButtonPicker,
  onOpenStickDirPicker,
  onChangeSelectedSize,
  onDone,
  fullscreenOverlay = false,
}) => {
  const [formMode, setFormMode] = useState<'new' | 'rename' | null>(null);
  const [mouseMenuOpen, setMouseMenuOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  const selectedButton =
    selection?.kind === 'button'
      ? activeProfile.buttons.find((b) => b.id === selection.id) ?? null
      : null;
  const stickSelected = selection?.kind === 'stick' && activeProfile.stick !== null;

  const currentSize: ControlButtonSize | null = selectedButton
    ? selectedButton.size
    : stickSelected && activeProfile.stick
      ? activeProfile.stick.size
      : null;

  const dirIcons: Array<{ dir: StickDirection; arrow: string; label: string }> = [
    { dir: 'up', arrow: '▲', label: 'Стик вверх' },
    { dir: 'down', arrow: '▼', label: 'Стик вниз' },
    { dir: 'left', arrow: '◀', label: 'Стик влево' },
    { dir: 'right', arrow: '▶', label: 'Стик вправо' },
  ];

  return (
    <div
      className={`shrink-0 px-2 py-1.5 flex flex-col gap-1.5 z-30 select-none border-b ${
        fullscreenOverlay
          ? 'bg-[#1B1C20]/90 backdrop-blur-sm border-white/15 shadow-lg'
          : 'bg-[#1B1C20] border-white/12'
      }`}
      role="toolbar"
      aria-label="Редактор кастомного управления"
    >
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        {/* Profile Controls */}
        <div className="flex items-center gap-1 flex-wrap">
          <CustomSelect
            ariaLabel="Выбрать профиль управления"
            value={profilesState.activeProfileId}
            options={profilesState.profiles.map((p) => ({ value: p.id, label: p.name }))}
            onChange={onSelectProfile}
            className="min-w-[115px] max-w-[165px]"
          />

          <button
            type="button"
            onClick={() => {
              setNameDraft('');
              setFormMode('new');
            }}
            aria-label="Новый профиль"
            title="Создать профиль"
            className="h-8 px-2 rounded-md bg-[#2A2D33] hover:bg-[#353941] text-[11px] font-semibold text-[#E6E2D9] flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5 text-[#8BC49A]" />
            <span className="hidden sm:inline">Профиль</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setNameDraft(activeProfile.name);
              setFormMode('rename');
            }}
            aria-label="Переименовать профиль"
            title="Переименовать профиль"
            className="h-8 w-8 rounded-md bg-[#2A2D33] hover:bg-[#353941] text-[#E6E2D9] flex items-center justify-center"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={onDeleteProfile}
            disabled={
              profilesState.profiles.length === 1 &&
              activeProfile.stick === null &&
              activeProfile.buttons.length === 0 &&
              activeProfile.name === 'Профиль 1'
            }
            aria-label="Удалить профиль"
            title="Удалить профиль"
            className="h-8 w-8 rounded-md bg-[#332224] hover:bg-[#492A2D] disabled:opacity-35 disabled:pointer-events-none text-[#FF9E98] flex items-center justify-center"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Add Elements & Done */}
        <div className="flex items-center gap-1 flex-wrap">
          <button
            type="button"
            onClick={() => {
              setMouseMenuOpen(false);
              onAddButton();
            }}
            className="h-8 px-2.5 rounded-md bg-[#2A2D33] hover:bg-[#353941] text-[11px] font-semibold text-[#F2EFE9] flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5 text-[#E07A22]" />
            <span>Кнопка</span>
          </button>

          <button
            type="button"
            aria-expanded={mouseMenuOpen}
            onClick={() => setMouseMenuOpen((v) => !v)}
            className={`h-8 px-2.5 rounded-md text-[11px] font-semibold flex items-center gap-1 ${
              mouseMenuOpen
                ? 'bg-[#E07A22] text-[#141518]'
                : 'bg-[#2A2D33] hover:bg-[#353941] text-[#F2EFE9]'
            }`}
          >
            <MousePointer className={`w-3.5 h-3.5 ${mouseMenuOpen ? 'text-[#141518]' : 'text-[#E07A22]'}`} />
            <span>+ Мышь</span>
          </button>

          {activeProfile.stick === null && (
            <button
              type="button"
              onClick={() => {
                setMouseMenuOpen(false);
                onAddStick();
              }}
              className="h-8 px-2.5 rounded-md bg-[#2A2D33] hover:bg-[#353941] text-[11px] font-semibold text-[#F2EFE9] flex items-center gap-1"
            >
              <Gamepad2 className="w-3.5 h-3.5 text-[#E07A22]" />
              <span>+ Стик</span>
            </button>
          )}

          <button
            type="button"
            onClick={onDone}
            className="h-8 px-3 rounded-md bg-[#C8342A] hover:bg-[#D94035] text-[11px] font-semibold text-white flex items-center gap-1"
          >
            <Check className="w-3.5 h-3.5" />
            <span>Готово</span>
          </button>
        </div>
      </div>

      {/* Quick Mouse Button Creator Row */}
      {mouseMenuOpen && (
        <div className="pt-1 border-t border-white/10 flex flex-wrap items-center justify-between gap-1.5">
          <span className="text-[11px] font-semibold text-[#BDB9B0]">
            Добавить кнопку мыши:
          </span>
          <div className="flex items-center gap-1.5 flex-wrap">
            {(
              [
                { button: 'left', label: 'ЛКМ (левая)' },
                { button: 'right', label: 'ПКМ (правая)' },
              ] as const
            ).map((item) => (
              <button
                key={item.button}
                type="button"
                onClick={() => {
                  onAddMouseButton(item.button);
                  setMouseMenuOpen(false);
                }}
                className="h-7 px-2.5 rounded-[4px] amiga-key-ivory text-[11px] font-semibold"
              >
                {item.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setMouseMenuOpen(false)}
              aria-label="Скрыть меню кнопок мыши"
              className="h-7 w-7 rounded-md bg-[#2A2D33] hover:bg-[#353941] text-[#D8D4CC] flex items-center justify-center"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Contextual row for selected Button or Stick (still completely outside the control zone!) */}
      {(selectedButton || stickSelected) && (
        <div className="pt-1 border-t border-white/10 flex flex-wrap items-center justify-between gap-1.5">
          {selectedButton && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={() => onOpenButtonPicker(selectedButton.id)}
                className="h-7 px-2.5 rounded-md bg-[#353941] hover:bg-[#424752] text-[11px] font-semibold text-[#F2EFE9] flex items-center gap-1.5"
              >
                {selectedButton.target.kind === 'mouse' ? (
                  <MousePointer className="w-3.5 h-3.5 text-[#E07A22]" />
                ) : selectedButton.target.kind === 'joy' ? (
                  <Gamepad2 className="w-3.5 h-3.5 text-[#E07A22]" />
                ) : (
                  <Keyboard className="w-3.5 h-3.5 text-[#E07A22]" />
                )}
                <span>
                  {selectedButton.target.kind === 'mouse'
                    ? 'Мышь'
                    : selectedButton.target.kind === 'joy'
                      ? 'Джойстик'
                      : selectedButton.target.kind === 'combo'
                        ? 'Сочетание'
                        : 'Клавиша'}
                  : {getTargetDisplayLabel(selectedButton.target, selectedButton.label)}
                </span>
              </button>
            </div>
          )}

          {stickSelected && activeProfile.stick && (
            <div className="flex items-center gap-1 flex-wrap">
              {dirIcons.map(({ dir, arrow, label }) => (
                <button
                  key={dir}
                  type="button"
                  aria-label={label}
                  onClick={() => onOpenStickDirPicker(dir)}
                  className="h-7 px-2 rounded-md bg-[#2A2D33] hover:bg-[#353941] border border-white/10 text-[11px] font-semibold text-[#F2EFE9] flex items-center gap-1"
                >
                  <span className="text-[#E07A22]">{arrow}</span>
                  <span>{getTargetDisplayLabel(activeProfile.stick![dir])}</span>
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-1.5">
            {currentSize && (
              <div className="flex items-center gap-0.5 bg-[#121316] p-0.5 rounded-md border border-white/10">
                {(['sm', 'md', 'lg'] as ControlButtonSize[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => onChangeSelectedSize(s)}
                    className={`h-6 px-2 rounded text-[10px] font-semibold uppercase ${
                      currentSize === s ? 'bg-[#C8342A] text-white' : 'text-[#BDB9B0] hover:text-white'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={onDeleteSelected}
              aria-label={stickSelected ? 'Удалить стик' : 'Удалить выбранную кнопку'}
              className="h-7 px-2 rounded-md bg-[#3B2224] hover:bg-[#4D292C] text-[#FF9E98] text-[11px] font-semibold flex items-center gap-1"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Удалить</span>
            </button>
          </div>
        </div>
      )}

      {/* Inline Create / Rename Profile Form */}
      {formMode && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = nameDraft.trim();
            if (!trimmed) return;
            if (formMode === 'new') onCreateProfile(trimmed);
            else onRenameProfile(trimmed);
            setFormMode(null);
          }}
          className="pt-1 border-t border-white/10 flex items-center gap-1.5"
        >
          <input
            type="text"
            autoFocus
            maxLength={40}
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            placeholder={formMode === 'new' ? 'Название нового профиля...' : 'Новое имя профиля...'}
            className="flex-1 h-8 px-2.5 rounded-md bg-[#111316] border border-white/15 text-xs text-[#F2EFE9] focus:outline-none focus:border-[#E07A22]"
          />
          <button
            type="submit"
            className="h-8 px-3 rounded-md bg-[#E07A22] text-[#141518] text-xs font-bold"
          >
            Сохранить
          </button>
          <button
            type="button"
            onClick={() => setFormMode(null)}
            aria-label="Отменить"
            className="h-8 w-8 rounded-md bg-[#2A2D33] text-[#D8D4CC] flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </form>
      )}
    </div>
  );
};
