export interface ApiMember {
  MemberType: string;
  Name: string;
  ValueType?: { Name: string };
  Tags?: string[];
}
export interface ApiClass { Name: string; Superclass: string; Members: ApiMember[]; }
export interface ApiDump { Classes: ApiClass[]; }

export interface PropInfo { name: string; valueType: string; }

const SKIP_TAGS = new Set(["Deprecated", "ReadOnly", "NotScriptable", "Hidden"]);

export function propertiesForClass(dump: ApiDump, className: string): PropInfo[] {
  const byName = new Map(dump.Classes.map((c) => [c.Name, c]));
  const props = new Map<string, PropInfo>();
  let current = byName.get(className);
  while (current) {
    for (const member of current.Members) {
      if (member.MemberType !== "Property") continue;
      if ((member.Tags ?? []).some((tag) => SKIP_TAGS.has(tag))) continue;
      if (!props.has(member.Name)) {
        props.set(member.Name, { name: member.Name, valueType: member.ValueType?.Name ?? "unknown" });
      }
    }
    current = current.Superclass === "<<<ROOT>>>" ? undefined : byName.get(current.Superclass);
  }
  return [...props.values()];
}
