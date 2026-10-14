export const EVIDENCE_DESK_SCOPE = {
  badge: 'SYNTHETIC CASE',
  short: 'NO TARGET CONTACT',
  label: 'Defensive review only',
  description: 'Fictional bundled evidence for local analysis. No targets are contacted, no investigative tools are executed, and no external sources are queried.',
  brief: [
    '- Case data: synthetic and fictional; it does not represent real people, systems, targets, or locations.',
    '- Target contact: none. This desk never contacts targets or sends messages on their behalf.',
    '- Investigative tools: none executed. The desk only validates and displays bundled local fixtures.',
    '- External actions and uploads: none. The case brief is generated locally from the bundled evidence.',
    '- External sources: none queried. No network intelligence or target-side data is collected.',
  ] as const,
} as const
