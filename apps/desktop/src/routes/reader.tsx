import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { Centered, Loading } from "@/components/ui";
import { ZoomableImage } from "@/components/zoomable-image";
import { api } from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import { colors } from "@/theme";

export const ReaderScreen = () => {
  const navigate = useNavigate();
  const { bookId = "", fileId = "" } = useParams<{
    bookId: string;
    fileId: string;
  }>();

  const textQuery = useQuery({
    queryKey: ["text", bookId, fileId],
    queryFn: () => api.fileText({ bookId, fileId }),
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-row items-center gap-3 border-b border-hairline px-6 py-3">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface"
        >
          <ChevronLeft size={18} color={colors.textSecondary} />
        </button>
        <span className="text-sm font-semibold text-text-secondary">
          Transcription · Scan
        </span>
      </div>

      <div className="flex flex-1 flex-row overflow-hidden">
        {/* Pane 1: transcription */}
        <div className="flex-1 overflow-y-auto border-r border-hairline">
          {textQuery.isLoading ? (
            <Loading />
          ) : textQuery.isError ? (
            <Centered>
              <p className="text-sm text-text-secondary">
                No transcription yet for this page.
              </p>
            </Centered>
          ) : (
            <div className="mx-auto max-w-2xl px-10 py-6">
              <Markdown source={textQuery.data ?? ""} />
            </div>
          )}
        </div>

        {/* Pane 2: original scan */}
        <div className="flex flex-1 items-center justify-center bg-bg p-4">
          <ZoomableImage bookId={bookId} fileId={fileId} />
        </div>
      </div>

      <div className="border-t border-hairline px-6 py-2 text-center">
        <span className="text-xs text-text-muted">
          Scroll to zoom the scan · drag to pan · double-click to reset
        </span>
      </div>
    </div>
  );
};
