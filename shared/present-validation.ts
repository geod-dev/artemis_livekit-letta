/** Shared limits and wire checks for model-authored `present` trees. */
export const PRESENT_LIMITS = {
  maxDepth: 32,
  maxNodes: 256,
  maxTotalBytes: 256 * 1024,
  maxStringBytes: 32 * 1024,
  maxSerializedChildrenBytes: 64 * 1024,
} as const;

export type PresentValidation =
  { ok: true; tree: Record<string, unknown> } | { ok: false; error: string };

type ComponentPropsValidator = (
  type: string,
  props: Record<string, unknown>,
) => boolean;

const ACTION_COMPONENTS = new Set([
  'Button',
  'Select',
  'Input',
  'DatePicker',
  'Checkbox',
  'Slider',
  'RadioGroup',
  'CheckboxGroup',
  'Form',
  'Card',
  'ListViewItem',
]);

/**
 * Validate a present tree and decode children encoded as JSON strings. The
 * caller supplies validators compiled from the component library's schemas.
 */
export function validatePresentTree(
  input: unknown,
  validateComponentProps: ComponentPropsValidator,
): PresentValidation {
  const bounds = checkBounds(input);
  if (bounds) return { ok: false, error: bounds };
  if (!isRecord(input))
    return { ok: false, error: "The root must be one component object." };

  const decoded = decodeNode(input, 0, { count: 1 }, validateComponentProps);
  return decoded.ok ? { ok: true, tree: decoded.value } : decoded;
}

type DecodeResult =
  { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

function decodeNode(
  input: unknown,
  depth: number,
  state: { count: number },
  validateProps: ComponentPropsValidator,
): DecodeResult {
  if (depth > PRESENT_LIMITS.maxDepth)
    return { ok: false, error: "The component tree is too deep." };
  if (!isRecord(input))
    return { ok: false, error: "Each component must be an object." };

  // Render stored library trees and translate the provider-safe tool protocol.
  const node = { ...input };
  for (const [wire, native] of [
    ['componentType', '$type'], ['componentKey', '$key'], ['action', '$action'],
  ]) {
    if (!Object.hasOwn(node, wire)) continue;
    if (Object.hasOwn(node, native))
      return { ok: false, error: "A component contains conflicting reserved properties." };
    node[native] = node[wire];
    delete node[wire];
  }
  const type = node.$type;
  if (typeof type !== "string")
    return { ok: false, error: "A component is missing its componentType." };
  const props = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(node)) {
    if (
      key === "$type" ||
      key === "$key" ||
      key === "$action" ||
      key === "children"
    )
      continue;
    if (key.startsWith("$"))
      return {
        ok: false,
        error: "A component contains an unsupported reserved property.",
      };
    props[key] = value;
  }
  if (type === "Card") {
    for (const key of ["confirm", "cancel"]) {
      const footer = props[key];
      if (isRecord(footer) && Object.hasOwn(footer, "action")) {
        if (Object.hasOwn(footer, "$action"))
          return { ok: false, error: "A component contains conflicting reserved properties." };
        const { action, ...rest } = footer;
        props[key] = { ...rest, $action: action };
        node[key] = props[key];
      }
    }
  }
  if (!validateProps(type, props))
    return {
      ok: false,
      error: "A component name or its properties are not supported.",
    };
  if (
    type === "Image" &&
    typeof props.src === "string" &&
    !isSafeImageUrl(props.src)
  ) {
    return { ok: false, error: "The image URL is not allowed." };
  }
  if (
    typeof props.background === "string" &&
    /url\s*\(|expression\s*\(/i.test(props.background)
  ) {
    return { ok: false, error: "The card background contains an unsafe CSS value." };
  }
  if (type === "Card") {
    for (const key of ["confirm", "cancel"]) {
      const footer = props[key];
      if (
        isRecord(footer) &&
        footer.$action !== undefined &&
        !isReplyAction(footer.$action)
      ) {
        return { ok: false, error: "Only the reply action is supported." };
      }
    }
  }
  if (
    node.$key !== undefined &&
    typeof node.$key !== "string" &&
    typeof node.$key !== "number"
  ) {
    return { ok: false, error: "A component $key must be a string or number." };
  }
  if (
    node.$action !== undefined &&
    (!ACTION_COMPONENTS.has(type) || !isReplyAction(node.$action))
  ) {
    return { ok: false, error: "Only the reply action is supported." };
  }

  const result: Record<string, unknown> = { ...node };
  if (Object.hasOwn(node, "children")) {
    const children = decodeSerializedChildren(node.children);
    if (!children.ok) return children;
    const childResult = decodeChildren(
      children.value,
      depth + 1,
      state,
      validateProps,
    );
    if (!childResult.ok) return childResult;
    result.children = childResult.value;
  }
  return { ok: true, value: result };
}

function decodeChildren(
  value: unknown,
  depth: number,
  state: { count: number },
  validateProps: ComponentPropsValidator,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (depth > PRESENT_LIMITS.maxDepth)
    return { ok: false, error: "The component tree is too deep." };
  state.count += 1;
  if (state.count > PRESENT_LIMITS.maxNodes)
    return { ok: false, error: "The component tree has too many nodes." };
  if (typeof value === "string") return { ok: true, value };
  if (Array.isArray(value)) {
    const children: unknown[] = [];
    for (const child of value) {
      const decoded = decodeChildren(child, depth + 1, state, validateProps);
      if (!decoded.ok) return decoded;
      children.push(decoded.value);
    }
    return { ok: true, value: children };
  }
  if (isRecord(value)) {
    const child = decodeNode(value, depth, state, validateProps);
    return child.ok ? { ok: true, value: child.value } : child;
  }
  return {
    ok: false,
    error: "Children must be text, components, or arrays of those values.",
  };
}

function decodeSerializedChildren(
  value: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (typeof value !== "string" || !/^\s*[\[{]/.test(value))
    return { ok: true, value };
  const bytes = byteLength(value);
  if (bytes > PRESENT_LIMITS.maxSerializedChildrenBytes) {
    return { ok: false, error: "Serialized children are too large." };
  }
  try {
    const parsed: unknown = JSON.parse(value);
    const containsNode = Array.isArray(parsed)
      ? parsed.some((item) => isRecord(item) && ("$type" in item || "componentType" in item))
      : isRecord(parsed) && ("$type" in parsed || "componentType" in parsed);
    return { ok: true, value: containsNode ? parsed : value };
  } catch {
    if (/"(?:\$type|componentType)"\s*:/.test(value)) {
      return {
        ok: false,
        error: "Serialized component children are malformed.",
      };
    }
    return { ok: true, value };
  }
}

function isReplyAction(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.type === "reply" &&
    (value.text === undefined || typeof value.text === "string") &&
    Object.keys(value).every((key) => key === "type" || key === "text")
  );
}

function isSafeImageUrl(value: string): boolean {
  const candidate = value.trim();
  if (
    !candidate ||
    /[\u0000-\u001f\\]/.test(candidate) ||
    candidate.startsWith("//")
  )
    return false;
  if (/^(?:javascript|vbscript|data|file):/i.test(candidate)) return false;
  if (/^[a-z][a-z\d+.-]*:/i.test(candidate)) return /^https?:/i.test(candidate);
  return true;
}

function checkBounds(root: unknown): string | undefined {
  const stack: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 0 },
  ];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (depth > PRESENT_LIMITS.maxDepth)
      return "The component tree is too deep.";
    if (typeof value === "string") {
      const size = byteLength(value);
      if (size > PRESENT_LIMITS.maxStringBytes)
        return "A string in the component tree is too large.";
      bytes += size;
      if (bytes > PRESENT_LIMITS.maxTotalBytes)
        return "The component tree is too large.";
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    if (seen.has(value))
      return "The component tree contains a cycle or shared object.";
    seen.add(value);
    nodes += 1;
    if (nodes > PRESENT_LIMITS.maxNodes * 20)
      return "The component tree is too large.";
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
    } else {
      for (const [key, child] of Object.entries(value)) {
        bytes += byteLength(key);
        if (bytes > PRESENT_LIMITS.maxTotalBytes)
          return "The component tree is too large.";
        stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return undefined;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
