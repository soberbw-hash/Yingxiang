import { useEffect, useState } from "react";
import {
  browserNotificationStatus,
  requestBrowserNotifications,
  sendBrowserNotification,
  type NotificationStatus,
} from "../services/browserNotifications";

const statusLabels: Record<NotificationStatus, string> = {
  default: "尚未授权",
  granted: "浏览器已允许",
  denied: "浏览器或公司策略已阻止",
  unsupported: "当前浏览器不支持系统通知",
  insecure: "当前地址不支持安全通知",
};

export function BrowserNotificationSettings({
  enabled,
  onChange,
  disabled = false,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void | Promise<void>;
  disabled?: boolean;
  immediate?: boolean;
}) {
  const [status, setStatus] = useState(browserNotificationStatus);
  const [requesting, setRequesting] = useState(false);
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    const update = () => setStatus(browserNotificationStatus());
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return (
    <fieldset className="feature-fields" disabled={disabled || requesting}>
      <legend>浏览器通知</legend>
      <p className="feature-note" role="status">
        {statusLabels[status]}
        {status === "granted"
          ? enabled
            ? " · 提醒已开启"
            : " · 提醒已关闭"
          : enabled
            ? " · 系统提醒尚未生效"
            : ""}
      </p>
      {status === "default" && (
        <p className="feature-note">
          授权后可测试系统通知；软件内「通知」列表不受此权限影响。
        </p>
      )}
      <div className="feature-actions">
        {status === "default" && (
          <button
            type="button"
            onClick={async () => {
              setRequesting(true);
              setFeedback("");
              try {
                const next = await requestBrowserNotifications();
                setStatus(next);
                if (next === "granted") {
                  await onChange(true);
                  setFeedback("浏览器已允许通知，可发送测试通知。");
                }
              } catch {
                setStatus(browserNotificationStatus());
                setFeedback(
                  "无法申请通知权限。请检查浏览器是否允许此站点通知；公司策略限制无法由网页更改。",
                );
              } finally {
                setRequesting(false);
              }
            }}
          >
            {requesting ? "等待你的选择…" : "开启浏览器通知"}
          </button>
        )}
        <button
          type="button"
          disabled={status !== "granted" || !enabled}
          onClick={() => {
            const result = sendBrowserNotification({
              enabled,
              test: true,
              title: "映箱 · 测试通知",
              body: "通知通道测试，不包含项目名、文件名或素材内容。",
              tag: "weave-test",
            });
            setFeedback(
              result === "submitted"
                ? "已提交测试通知，请检查 Windows 通知中心。系统勿扰模式可能隐藏横幅；这不代表通知已送达。"
                : "未能提交通知，请检查浏览器权限与系统通知设置。",
            );
            setStatus(browserNotificationStatus());
          }}
        >
          发送测试通知
        </button>
      </div>
      {status === "denied" && (
        <p className="feature-note">
          系统通知被浏览器或公司策略阻止，网页不能绕过。软件内「通知」列表仍可使用；请勿更改公司安全策略。
        </p>
      )}
      {status === "insecure" && (
        <p className="feature-note">
          请使用允许访问的 HTTPS 地址。本地 HTML
          能否授权通知取决于浏览器，不保证可用。
        </p>
      )}
      {feedback && (
        <p className="feature-note" role="status">
          {feedback}
        </p>
      )}
    </fieldset>
  );
}
