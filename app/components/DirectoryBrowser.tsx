import { useState } from 'react';
import { useTRPC } from '~/lib/trpc';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '~/components/ui/dialog';
import { Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbSeparator } from '~/components/ui/breadcrumb';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { ScrollArea } from '~/components/ui/scroll-area';
import { Folder } from 'lucide-react';

interface DirectoryBrowserProps {
  initialPath?: string;
  onSelect: (path: string, isGitRepo: boolean) => void;
  onCancel: () => void;
}

export default function DirectoryBrowser({ initialPath = '/home/ryan', onSelect, onCancel }: DirectoryBrowserProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const trpc = useTRPC();

  const { data, isLoading } = useQuery(trpc.projects.browse.queryOptions({ path: currentPath }));

  const segments = currentPath.split('/').filter(Boolean);

  function navigateTo(path: string) {
    setCurrentPath(path);
  }

  function navigateToBreadcrumb(idx: number) {
    const path = '/' + segments.slice(0, idx + 1).join('/');
    setCurrentPath(path);
  }

  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="max-w-lg flex flex-col max-h-[80vh] p-0 gap-0" showCloseButton={false}>
        <DialogHeader className="px-4 pt-4 pb-2 border-b space-y-2">
          <DialogTitle className="sr-only">Browse Directories</DialogTitle>
          <Breadcrumb>
            <BreadcrumbList className="flex-nowrap overflow-x-auto">
              <BreadcrumbItem>
                <BreadcrumbLink
                  href="#"
                  onClick={(e) => { e.preventDefault(); setCurrentPath('/'); }}
                  className="cursor-pointer font-medium"
                >
                  /
                </BreadcrumbLink>
              </BreadcrumbItem>
              {segments.map((seg, i) => (
                <BreadcrumbItem key={i}>
                  <BreadcrumbSeparator>/</BreadcrumbSeparator>
                  <BreadcrumbLink
                    href="#"
                    onClick={(e) => { e.preventDefault(); navigateToBreadcrumb(i); }}
                    className="cursor-pointer"
                  >
                    {seg}
                  </BreadcrumbLink>
                </BreadcrumbItem>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
          {data?.isGitRepo && (
            <Badge variant="outline" className="text-green-700 border-green-300 bg-green-50 w-fit">
              <span className="w-2 h-2 rounded-full bg-green-500" />
              Git Repository
            </Badge>
          )}
        </DialogHeader>

        {/* Directory list */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="max-h-64">
            {isLoading && (
              <div className="p-4 text-sm text-muted-foreground">Loading...</div>
            )}
            {data?.error && (
              <div className="p-4 text-sm text-destructive">{data.error}</div>
            )}
            {data && !data.error && data.dirs.length === 0 && (
              <div className="p-4 text-sm text-muted-foreground">No subdirectories</div>
            )}
            {data?.dirs.map((dir) => (
              <Button
                key={dir.path}
                variant="ghost"
                className="w-full justify-start rounded-none h-auto px-4 py-2 text-sm font-normal"
                onClick={() => navigateTo(dir.path)}
              >
                <Folder className="size-4 text-muted-foreground shrink-0" />
                <span>{dir.name}</span>
              </Button>
            ))}
          </div>
        </ScrollArea>

        {/* Footer actions */}
        <DialogFooter className="px-4 py-3 border-t">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            onClick={() => onSelect(currentPath, data?.isGitRepo ?? false)}
          >
            Select
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
