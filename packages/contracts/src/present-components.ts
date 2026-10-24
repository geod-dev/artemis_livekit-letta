/**
 * The component vocabulary of the `present` tool, in the order the generated schema lists
 * it. The web app implements each name (its prop schema and renderer) in
 * apps/web/src/lib/present-library.ts; scripts/generate-present-tool.ts fails when that
 * library and this list differ. Plain data, so this package keeps no runtime dependency.
 */
export const PRESENT_COMPONENT_NAMES = [
  'Header',
  'Text',
  'Caption',
  'Image',
  'Divider',
  'Fact',
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
  'Col',
  'Row',
  'Spacer',
  'Badge',
  'Box',
  'ListView',
  'ListViewItem',
  'Table',
  'Markdown',
  'Chart',
  'Alert',
  'Carousel',
  'Icon',
] as const;
