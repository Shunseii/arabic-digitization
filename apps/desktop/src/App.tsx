import { QueryClientProvider } from "@tanstack/react-query";
import { Outlet, Route, Routes } from "react-router-dom";
import { Sidebar } from "@/components/sidebar";
import { ConfigProvider } from "@/lib/config-context";
import { queryClient } from "@/lib/query";
import { ActivityScreen } from "@/routes/activity";
import { BookScreen } from "@/routes/book";
import { LibraryScreen } from "@/routes/library";
import { NewBookScreen } from "@/routes/new-book";
import { ReaderScreen } from "@/routes/reader";
import { SettingsScreen } from "@/routes/settings";
import { UploadScreen } from "@/routes/upload";

const AppLayout = () => (
  <div className="flex h-screen w-screen overflow-hidden bg-bg text-ink">
    <Sidebar />
    <main className="flex flex-1 flex-col overflow-hidden">
      <Outlet />
    </main>
  </div>
);

export const App = () => (
  <QueryClientProvider client={queryClient}>
    <ConfigProvider>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<LibraryScreen />} />
          <Route path="/activity" element={<ActivityScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="/new-book" element={<NewBookScreen />} />
          <Route path="/book/:id" element={<BookScreen />} />
          <Route path="/upload/:bookId" element={<UploadScreen />} />
          <Route path="/reader/:bookId/:fileId" element={<ReaderScreen />} />
        </Route>
      </Routes>
    </ConfigProvider>
  </QueryClientProvider>
);
