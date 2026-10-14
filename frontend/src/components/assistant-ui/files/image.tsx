import { type PropsWithChildren, memo, useEffect, useRef, useState } from 'react';
import { ImageIcon, ImageOffIcon, Loader2Icon, ShieldAlertIcon, XIcon } from 'lucide-react';
import type { ImageMessagePartComponent } from '@assistant-ui/react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { cn } from '@/lib/shadcn/utils';

type ImageRootProps = React.ComponentProps<'div'>;

function ImageRoot({ className, children, ...props }: ImageRootProps) {
  return (
    <div
      data-slot="image-root"
      className={cn(
        'aui-image-root border-border relative max-w-96 overflow-hidden rounded-lg border',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

type ImagePreviewProps = Omit<React.ComponentProps<'img'>, 'children'> & {
  containerClassName?: string | undefined;
  ratio?: 'auto' | '1:1' | '4:3' | '16:9' | '9:16' | undefined;
  fit?: 'cover' | 'contain' | undefined;
};

function ImagePreview({
  className,
  containerClassName,
  ratio = 'auto',
  fit = 'contain',
  onLoad,
  onError,
  alt = 'Image content',
  src,
  ...props
}: ImagePreviewProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | undefined>(undefined);
  const [errorSrc, setErrorSrc] = useState<string | undefined>(undefined);

  const loaded = loadedSrc === src;
  const error = errorSrc === src;
  const fixedRatio = ratio !== 'auto';
  const ratioClassName =
    ratio === '1:1'
      ? 'aspect-square'
      : ratio === '4:3'
        ? 'aspect-[4/3]'
        : ratio === '16:9'
          ? 'aspect-video'
          : ratio === '9:16'
            ? 'aspect-[9/16]'
            : undefined;

  useEffect(() => {
    const image = imgRef.current;
    if (typeof src !== 'string' || !image?.complete) return;
    if (image.naturalWidth > 0) setLoadedSrc(src);
    else setErrorSrc(src);
  }, [src]);

  return (
    <div
      data-slot="image-preview"
      className={cn('relative', fixedRatio ? ratioClassName : 'min-h-32', containerClassName)}
    >
      {!loaded && !error && (
        <div
          data-slot="image-preview-loading"
          className="bg-muted/50 absolute inset-0 flex items-center justify-center"
        >
          <ImageIcon className="text-muted-foreground size-8 animate-pulse" />
        </div>
      )}
      {error ? (
        <div
          data-slot="image-preview-error"
          className={cn(
            'bg-muted/50 flex min-h-32 items-center justify-center p-4',
            fixedRatio && 'absolute inset-0'
          )}
        >
          <ImageOffIcon className="text-muted-foreground size-8" />
        </div>
      ) : (
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          className={cn(
            fixedRatio
              ? cn('block h-full w-full', {
                  'object-cover': fit === 'cover',
                  'object-contain': fit === 'contain',
                })
              : 'block h-auto w-full object-contain',
            !loaded && 'invisible',
            className
          )}
          onLoad={(e) => {
            if (typeof src === 'string') setLoadedSrc(src);
            onLoad?.(e);
          }}
          onError={(e) => {
            if (typeof src === 'string') setErrorSrc(src);
            onError?.(e);
          }}
          {...props}
        />
      )}
    </div>
  );
}

function ImageFilename({ className, children, ...props }: React.ComponentProps<'span'>) {
  if (!children) return null;

  return (
    <span
      data-slot="image-filename"
      className={cn('text-muted-foreground block truncate px-2 py-1.5 text-xs', className)}
      {...props}
    >
      {children}
    </span>
  );
}

type ImageZoomProps = PropsWithChildren<{
  src: string;
  alt?: string;
}>;

function ImageZoom({ src, alt = 'Image preview', children }: ImageZoomProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          className="aui-image-zoom-trigger cursor-zoom-in"
          aria-label="Click to zoom image"
        >
          {children}
        </div>
      </DialogTrigger>
      <DialogContent
        data-slot="image-zoom-overlay"
        aria-label="Zoomed image"
        className="aui-image-zoom-overlay flex h-[90vh] w-[90vw] max-w-none items-center justify-center border-0 bg-black/80 p-0 shadow-none sm:max-w-none"
        overlayClassName="bg-black/80"
        onClick={() => setIsOpen(false)}
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <img
          data-slot="image-zoom-content"
          src={src}
          alt={alt}
          className="aui-image-zoom-content fade-in zoom-in-95 animate-in max-h-[90vh] max-w-[90vw] cursor-zoom-out object-contain duration-200"
          onClick={() => setIsOpen(false)}
        />
        <DialogClose
          aria-label="Close zoomed image"
          className="bg-background/80 absolute end-4 top-4 rounded-md p-2"
        >
          <span className="sr-only">Close zoomed image</span>
          <XIcon className="size-5" />
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

function ImageGenerating({ className }: { className?: string }) {
  return (
    <div
      data-slot="image-generating"
      className={cn('bg-muted/50 flex min-h-32 items-center justify-center p-4', className)}
    >
      <Loader2Icon className="text-muted-foreground size-8 animate-spin" />
      <span className="sr-only">Generating image…</span>
    </div>
  );
}

function ImageContentFilterError({ className, reason }: { className?: string; reason?: string }) {
  return (
    <div
      data-slot="image-content-filter-error"
      className={cn(
        'bg-muted/50 flex min-h-32 flex-col items-center justify-center gap-2 p-4 text-center',
        className
      )}
    >
      <ShieldAlertIcon className="text-muted-foreground size-8" />
      <p className="text-sm font-medium">Image could not be generated</p>
      {reason && <p className="text-muted-foreground text-xs">{reason}</p>}
    </div>
  );
}

const ImageImpl: ImageMessagePartComponent = (props) => {
  const { image, filename, status } = props;

  if (status?.type === 'running') {
    return (
      <ImageRoot>
        <ImageGenerating />
        <ImageFilename>{filename}</ImageFilename>
      </ImageRoot>
    );
  }

  if (status?.type === 'incomplete' && status.reason === 'content-filter') {
    return (
      <ImageRoot>
        <ImageContentFilterError reason="The provider blocked this image." />
      </ImageRoot>
    );
  }

  return (
    <ImageRoot>
      <ImageZoom src={image} alt={filename || 'Image content'}>
        <ImagePreview src={image} alt={filename || 'Image content'} />
      </ImageZoom>
      <ImageFilename>{filename}</ImageFilename>
    </ImageRoot>
  );
};

const Image = memo(ImageImpl) as ImageMessagePartComponent;
Image.displayName = 'Image';

export { Image };
