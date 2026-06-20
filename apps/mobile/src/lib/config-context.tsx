import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  type ApiConfig,
  clearConfig,
  loadConfig,
  peekConfig,
  saveConfig,
} from "./config";

interface ConfigContextValue {
  /** null while loading, then the config or null if unset. */
  config: ApiConfig | null;
  ready: boolean;
  configured: boolean;
  save: (next: ApiConfig) => Promise<void>;
  clear: () => Promise<void>;
}

const ConfigContext = createContext<ConfigContextValue | null>(null);

export const ConfigProvider = ({ children }: { children: ReactNode }) => {
  const [config, setConfig] = useState<ApiConfig | null>(peekConfig());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    loadConfig().then((loaded) => {
      setConfig(loaded);
      setReady(true);
    });
  }, []);

  const value = useMemo<ConfigContextValue>(
    () => ({
      config,
      ready,
      configured: config != null,
      save: async (next) => {
        await saveConfig(next);
        setConfig(peekConfig());
      },
      clear: async () => {
        await clearConfig();
        setConfig(null);
      },
    }),
    [config, ready],
  );

  return (
    <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>
  );
};

export const useConfigState = (): ConfigContextValue => {
  const ctx = useContext(ConfigContext);
  if (!ctx)
    throw new Error("useConfigState must be used within ConfigProvider");
  return ctx;
};
