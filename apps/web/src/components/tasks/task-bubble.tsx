export function TaskBubble({
  description,
  text,
  prefix = '',
}: {
  description: string;
  text?: string;
  prefix?: string;
}) {
  return (
    <div className="bg-muted/70 ml-auto w-fit max-w-[80%] rounded-2xl px-3 py-2">
      <div className="text-muted-foreground mb-1 text-[9px] leading-4 [overflow-wrap:anywhere]">
        {description}
      </div>
      <div className="text-foreground/80 text-[13px] leading-5 [overflow-wrap:anywhere] whitespace-pre-wrap">
        {text ? `${prefix}${text}` : 'The input is unavailable for this run.'}
      </div>
    </div>
  );
}
