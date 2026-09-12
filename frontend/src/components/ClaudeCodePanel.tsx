import SkillsPanel from './SkillsPanel';

export default function ClaudeCodePanel() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Skills are shared: opencode loads <code className="font-mono text-xs">~/.claude/skills</code> and{' '}
        <code className="font-mono text-xs">~/.agents/skills</code> automatically.
      </p>
      <SkillsPanel />
    </div>
  );
}
