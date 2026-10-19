/**
 * Menu builder journey navigation.
 *
 * Building a menu has three stages, with one clear main action per stage:
 *   1. Create menu
 *   2. Add items
 *   3. Save and preview
 *
 * Pure helpers only: no auth, storage, or API authority. Callers pass the
 * facts they already read natively (menu counts, item counts, whether the
 * draft was kept) and the current stage is derived, never stored.
 */

export type MenuJourneyStageId =
  | "create-menu"
  | "add-items"
  | "save-and-preview";

export interface MenuJourneyStage {
  id: MenuJourneyStageId;
  step: number;
  stageCount: number;
  title: string;
  mainActionLabel: string;
  hint: string;
  isComplete: boolean;
}

const STAGE_ORDER: MenuJourneyStageId[] = [
  "create-menu",
  "add-items",
  "save-and-preview",
];

const STAGE_COPY: Record<
  MenuJourneyStageId,
  { title: string; mainActionLabel: string; hint: string }
> = {
  "create-menu": {
    title: "Create menu",
    mainActionLabel: "Create menu",
    hint: "Start with a menu. You can rename it or add another one later.",
  },
  "add-items": {
    title: "Add items",
    mainActionLabel: "Add item",
    hint: "Add what you sell, with prices. This is what customers will see.",
  },
  "save-and-preview": {
    title: "Save and preview",
    mainActionLabel: "Save and preview",
    hint: "Save your work, then check how the menu looks to customers.",
  },
};

function toStage(id: MenuJourneyStageId, isComplete: boolean): MenuJourneyStage {
  const copy = STAGE_COPY[id];
  return {
    id,
    step: STAGE_ORDER.indexOf(id) + 1,
    stageCount: STAGE_ORDER.length,
    title: copy.title,
    mainActionLabel: copy.mainActionLabel,
    hint: copy.hint,
    isComplete,
  };
}

/** Owner workspace: a signed-in owner working on a business's menus. */
export function getOwnerMenuJourneyStage(input: {
  menuCount: number;
  hasSelectedMenu: boolean;
  selectedMenuItemCount: number;
}): MenuJourneyStage {
  if (input.menuCount === 0 || !input.hasSelectedMenu) {
    return toStage("create-menu", false);
  }
  if (input.selectedMenuItemCount === 0) {
    return toStage("add-items", false);
  }
  return toStage("save-and-preview", false);
}

/**
 * Guest/private draft editor: the draft being designed is the menu, so the
 * journey starts at adding items. The final stage is complete only when the
 * draft was actually kept on this device (native save readback).
 */
export function getGuestMenuJourneyStage(input: {
  hasNamedItem: boolean;
  kept: boolean;
}): MenuJourneyStage {
  if (!input.hasNamedItem) {
    return toStage("add-items", false);
  }
  return toStage("save-and-preview", input.kept);
}
