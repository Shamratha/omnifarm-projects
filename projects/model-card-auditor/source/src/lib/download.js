export function downloadReviewPacket(cardId, packet) {
  const url = URL.createObjectURL(new Blob([packet], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `prism-${cardId}-review.md`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
