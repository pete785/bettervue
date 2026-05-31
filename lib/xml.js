function parseXml(xml) {
  const root = { tag: "#document", attrs: {}, children: [], text: "" };
  const stack = [root];
  const tagRegex = /<\/?([A-Za-z0-9:_-]+)([^>]*?)(\/?)>|([^<]+)/g;
  let match;

  while ((match = tagRegex.exec(xml)) !== null) {
    const [, tagName, attrPart, selfClose, textNode] = match;

    if (textNode) {
      stack[stack.length - 1].children.push({ tag: "#text", text: textNode });
      continue;
    }

    const closing = match[0].startsWith("</");
    if (closing) {
      stack.pop();
      continue;
    }

    const node = {
      tag: tagName,
      attrs: parseAttrs(attrPart || ""),
      children: [],
      text: "",
    };

    stack[stack.length - 1].children.push(node);

    if (!selfClose) {
      stack.push(node);
    }
  }

  return root;
}

function parseAttrs(attrPart) {
  const attrs = {};
  const attrRegex = /([A-Za-z0-9:_-]+)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = attrRegex.exec(attrPart)) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function getElements(node, tagName) {
  const results = [];
  walk(node, (child) => {
    if (child.tag === tagName) {
      results.push(child);
    }
  });
  return results;
}

function firstElement(nodes) {
  return nodes && nodes.length ? nodes[0] : null;
}

function getAttr(node, name) {
  return node?.attrs?.[name] ?? "";
}

function getText(node) {
  if (!node) return "";
  if (node.tag === "#text") return node.text;
  return node.children
    .filter((child) => child.tag === "#text")
    .map((child) => child.text)
    .join("")
    .trim();
}

function walk(node, fn) {
  for (const child of node.children || []) {
    if (child.tag === "#text") continue;
    fn(child);
    walk(child, fn);
  }
}

module.exports = {
  parseXml,
  getElements,
  getAttr,
  getText,
  firstElement,
};
