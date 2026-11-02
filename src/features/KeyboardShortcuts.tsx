import { FeatureDialog } from "./shared";

export function KeyboardShortcuts({ onClose }: { onClose: () => void }) {
  const groups = [
    { title: "查找与预览", items: [["Ctrl / ⌘ + F", "搜索当前工作区"], ["空格", "预览指向或选中的素材；再次按下关闭"], ["← / →", "在快速预览中切换素材"], ["Esc", "关闭弹窗、菜单或取消素材选择"]] },
    { title: "选择与编辑", items: [["Ctrl / ⌘ + A", "素材网格中全选当前筛选结果"], ["Ctrl / ⌘ + 单击", "多选素材"], ["Shift + 单击", "连续选择素材或段落编号"], ["Ctrl / ⌘ + Z", "撤回剪辑文稿修改"], ["Ctrl / ⌘ + Shift + Z", "重做剪辑文稿修改"], ["Delete", "素材库中移入回收站"]] },
  ];
  return <FeatureDialog title="快捷键" onClose={onClose}><div className="shortcut-guide">
    {groups.map(group => <section key={group.title}><h3>{group.title}</h3><dl>{group.items.map(([key, text]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{text}</dd></div>)}</dl></section>)}
    <p>输入文字时保留原生的复制、粘贴和撤回。按 ? 随时查看快捷键。</p>
  </div></FeatureDialog>;
}
