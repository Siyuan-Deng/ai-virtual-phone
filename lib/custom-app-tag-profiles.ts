import type { InstalledCustomApp } from "./custom-app-types";
import type { Prompt, RegexConfig } from "./settings-types";
import type { TagGroupProfile, TagMinorProfile, TagProfile } from "./content-tag-utils";
import { areTagsEqual, resolveContentTagLabel } from "./content-tag-utils";

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function cleanId(value: unknown): string {
  return cleanText(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stringArray(value: unknown, maxLength = 120): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(item => cleanText(item, maxLength)).filter(Boolean)));
}

function tagLabel(tags: string[]): string {
  return tags.length > 0 ? tags.map(resolveContentTagLabel).join(" · ") : "通用";
}

function tagKey(tags: string[]): string {
  return JSON.stringify(tags);
}

type GroupBuilder = {
  id: string;
  label: string;
  tags: string[];
  minors: TagMinorProfile[];
  minorKeys: Set<string>;
};

function getBuilder(builders: Map<string, GroupBuilder>, app: InstalledCustomApp): GroupBuilder {
  const appKey = cleanId(app.id) || cleanId(app.name) || "custom_app";
  const id = `custom_app_${appKey}`;
  const existing = builders.get(id);
  if (existing) return existing;
  const builder: GroupBuilder = {
    id,
    label: app.name || app.manifest.name || "自定义 APP",
    tags: [],
    minors: [],
    minorKeys: new Set(),
  };
  builders.set(id, builder);
  return builder;
}

function addMinor(builder: GroupBuilder, tags: string[], label?: string): void {
  if (tags.length === 0) return;
  const key = tagKey(tags);
  if (builder.minorKeys.has(key)) return;
  builder.minorKeys.add(key);
  builder.minors.push({
    id: `${builder.id}_${cleanId(tags.join("_")) || builder.minors.length + 1}`,
    label: cleanText(label, 80) || tagLabel(tags),
    tags,
  });
}

function addTagSet(builder: GroupBuilder, tags: string[], label?: string): void {
  if (tags.length === 0) return;
  if (builder.tags.length === 0) builder.tags = [tags[0]];
  if (tags.length > 1) addMinor(builder, [tags[0]], "通用");
  addMinor(builder, tags, label);
}

function tagsFromScene(value: { tag?: string; tags?: string[]; appTags?: string[] }): string[] {
  return stringArray(value.tags).length > 0
    ? stringArray(value.tags)
    : stringArray(value.appTags).length > 0
      ? stringArray(value.appTags)
      : cleanText(value.tag, 120)
        ? [cleanText(value.tag, 120)]
        : [];
}

function addManifestTags(builders: Map<string, GroupBuilder>, app: InstalledCustomApp): void {
  const builder = getBuilder(builders, app);
  for (const primaryTag of stringArray(app.manifest.primaryTags)) {
    addTagSet(builder, [primaryTag], "通用");
  }
  const chatBlocks = [app.manifest.chatExtensions, app.manifest.extensions?.chat].filter(Boolean);
  for (const chat of chatBlocks) {
    for (const scene of chat?.scenes ?? []) addTagSet(builder, tagsFromScene(scene), scene.label);
    for (const directive of chat?.directives ?? []) addTagSet(builder, stringArray(directive.tags), directive.label);
    for (const action of chat?.plusActions ?? []) addTagSet(builder, stringArray(action.tags), action.label);
  }
  for (const directive of app.manifest.chatDirectives ?? []) addTagSet(builder, stringArray(directive.tags), directive.label);
  for (const action of app.manifest.chatPlusActions ?? []) addTagSet(builder, stringArray(action.tags), action.label);
  const promptProfiles = [
    ...(app.manifest.promptProfiles ?? []),
    ...(app.manifest.extensions?.prompt?.profiles ?? []),
  ];
  for (const profile of promptProfiles) addTagSet(builder, stringArray(profile.appTags), profile.label);
}

function promptPrefix(app: InstalledCustomApp): string {
  return `custom_app_${cleanId(app.id)}_prompt_`;
}

function regexPrefix(app: InstalledCustomApp): string {
  return `custom_app_${cleanId(app.id)}_regex_`;
}

function addImportedPromptTags(builders: Map<string, GroupBuilder>, app: InstalledCustomApp, prompts: Prompt[]): void {
  const prefix = promptPrefix(app);
  const builder = getBuilder(builders, app);
  for (const prompt of prompts) {
    if (!prompt.identifier.startsWith(prefix)) continue;
    addTagSet(builder, stringArray(prompt.tags), prompt.name);
  }
}

function addImportedRegexTags(builders: Map<string, GroupBuilder>, app: InstalledCustomApp, regexes: RegexConfig[]): void {
  const prefix = regexPrefix(app);
  const builder = getBuilder(builders, app);
  for (const group of regexes) {
    if (!group.id.startsWith(prefix)) continue;
    for (const rule of group.rules ?? []) {
      addTagSet(builder, stringArray(rule.tags), rule.scriptName || group.name);
      for (const set of rule.tagSets ?? []) addTagSet(builder, stringArray(set), rule.scriptName || group.name);
    }
  }
}

export function buildCustomAppTagGroups(
  apps: InstalledCustomApp[],
  sources?: { prompts?: Prompt[]; regexes?: RegexConfig[] },
): TagGroupProfile[] {
  const builders = new Map<string, GroupBuilder>();
  for (const app of apps) {
    addManifestTags(builders, app);
    if (sources?.prompts) addImportedPromptTags(builders, app, sources.prompts);
    if (sources?.regexes) addImportedRegexTags(builders, app, sources.regexes);
  }
  return Array.from(builders.values())
    .filter(builder => builder.minors.length > 0)
    .map(builder => ({
      id: builder.id,
      label: builder.label,
      tags: builder.tags,
      minors: builder.minors,
    }));
}

export function flattenTagGroups(groups: TagGroupProfile[]): TagProfile[] {
  return groups.flatMap(group => group.minors.map(minor => ({
    id: minor.id,
    label: minor.tags.length === 0 ? "通用（所有功能）" : `${group.label}${minor.tags.length > 1 ? ` · ${minor.label}` : ""}`,
    tags: minor.tags,
  })));
}

export function findTagGroupForTags(groups: TagGroupProfile[], tags: string[]): TagGroupProfile | undefined {
  return groups.find(group => group.minors.some(minor => areTagsEqual(minor.tags, tags)));
}
