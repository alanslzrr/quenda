export interface ComboboxOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Extra words that find this option without being shown. */
  keywords?: string[];
  /** Heading the option is listed under, such as its facility. Options sharing a group are listed together, in first-appearance order. */
  group?: string;
  /** Secondary note shown after the label and read with it, such as "retirado". */
  hint?: string;
}

/** One block of the list: a group heading with its options, or ungrouped options. `index` is the option's position in keyboard order. */
export interface OptionSection {
  group?: string;
  options: { option: ComboboxOption; index: number }[];
}

/** Case- and accent-insensitive search text, so "pavillon" finds "Pavillón" and "espana" finds "España". */
export function normalizeSearch(text: string) {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("es").trim();
}

/** Options whose label, keywords, hint or group contain the query. An empty query keeps every option. */
export function filterOptions(options: readonly ComboboxOption[], query: string): ComboboxOption[] {
  const needle = normalizeSearch(query);
  if (!needle) return [...options];
  return options.filter((option) =>
    [option.label, option.hint, option.group, ...(option.keywords ?? [])].some(
      (term) => term !== undefined && normalizeSearch(term).includes(needle),
    ),
  );
}

/**
 * Groups options under their headings, keeping the first-appearance order of groups and of options within each group.
 * Only groups with at least one option appear, so filtering drops the headings of groups without matches.
 * Ungrouped options form their own sections where they first appear. Indexes number the options in the order shown.
 */
export function sectionOptions(options: readonly ComboboxOption[]): OptionSection[] {
  const sections: { group?: string; options: ComboboxOption[] }[] = [];
  const byGroup = new Map<string, { group?: string; options: ComboboxOption[] }>();
  let loose: { group?: string; options: ComboboxOption[] } | null = null;
  for (const option of options) {
    if (option.group === undefined || option.group === "") {
      if (!loose) {
        loose = { options: [] };
        sections.push(loose);
      }
      loose.options.push(option);
      continue;
    }
    loose = null;
    let section = byGroup.get(option.group);
    if (!section) {
      section = { group: option.group, options: [] };
      byGroup.set(option.group, section);
      sections.push(section);
    }
    section.options.push(option);
  }
  let index = 0;
  return sections.map((section) => ({
    ...(section.group === undefined ? {} : { group: section.group }),
    options: section.options.map((option) => ({ option, index: index++ })),
  }));
}

/** The options in the order they are shown, which is also the arrow-key order. */
export const orderedOptions = (sections: readonly OptionSection[]) =>
  sections.flatMap((section) => section.options.map((item) => item.option));
