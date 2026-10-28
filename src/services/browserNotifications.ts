export type NotificationStatus =
  | NotificationPermission
  | "unsupported"
  | "insecure";
export type NotificationResult =
  | "submitted"
  | "disabled"
  | "foreground"
  | "unavailable"
  | "failed";

// Injectable boundary for tests; permission is requested only by the settings button.
export type NotificationEnvironment = {
  secure: boolean;
  supported: boolean;
  permission: () => NotificationPermission;
  request: () => Promise<NotificationPermission>;
  hidden: () => boolean;
  send: (
    title: string,
    body: string,
    tag: string,
    onClick?: () => void,
  ) => void;
};

function environment(): NotificationEnvironment {
  const supported = typeof window !== "undefined" && "Notification" in window;
  return {
    secure: typeof window !== "undefined" && window.isSecureContext,
    supported,
    permission: () => (supported ? Notification.permission : "default"),
    request: () => Notification.requestPermission(),
    hidden: () => document.visibilityState === "hidden" || !document.hasFocus(),
    send: (title, body, tag, onClick) => {
      const notification = new Notification(title, { body, tag });
      notification.onclick = () => {
        window.focus();
        notification.close();
        onClick?.();
      };
    },
  };
}

export function browserNotificationStatus(
  env = environment(),
): NotificationStatus {
  if (!env.secure) return "insecure";
  if (!env.supported) return "unsupported";
  return env.permission();
}

export async function requestBrowserNotifications(
  env = environment(),
): Promise<NotificationStatus> {
  const status = browserNotificationStatus(env);
  if (status !== "default") return status;
  // Do not await anything before request(): preserve the click's user activation.
  return env.request();
}

export function sendBrowserNotification(
  options: {
    enabled: boolean;
    title: string;
    body: string;
    tag: string;
    test?: boolean;
    onClick?: () => void;
  },
  env = environment(),
): NotificationResult {
  if (!options.enabled) return "disabled";
  if (browserNotificationStatus(env) !== "granted") return "unavailable";
  if (!options.test && !env.hidden()) return "foreground";
  try {
    env.send(options.title, options.body, options.tag, options.onClick);
    return "submitted";
  } catch {
    // Notification failure must never turn a successful project write into an error.
    return "failed";
  }
}

export function notifyBrowserTask(
  method: string,
  result: { canceled?: boolean } | undefined,
  enabled: boolean,
  failed = false,
  env = environment(),
): NotificationResult | undefined {
  if (method !== "importFiles" && method !== "exportProject") return;
  if (result?.canceled) return;
  const importing = method === "importFiles";
  return sendBrowserNotification(
    {
      enabled,
      title: failed
        ? "映箱 · 任务未完成"
        : `映箱 · ${importing ? "导入完成" : "导出已生成"}`,
      body: failed
        ? "请返回映箱 查看错误详情。"
        : importing
          ? "素材已写入本机项目。返回映箱 继续整理。"
          : "ZIP 已生成并请求浏览器下载，请在下载列表确认保存结果。",
      // Replace related pending toasts instead of one notification per file.
      tag: `weave-task-${method}`,
    },
    env,
  );
}
