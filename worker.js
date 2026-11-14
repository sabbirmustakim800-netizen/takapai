/**
 * টাকাপাই — স্ট্যাটিক সাইট ওয়ার্কার
 * সব রিকোয়েস্ট স্ট্যাটিক অ্যাসেট থেকেই সার্ভ হয়।
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ছোট নিরাপত্তা: সোর্স ম্যাপ বা লুকানো ফাইল কেউ চাইলে দেব না
    if (url.pathname.startsWith('/.') || url.pathname.endsWith('.map')) {
      return new Response('Not found', { status: 404 });
    }

    const response = await env.ASSETS.fetch(request);

    // HTML-এ সবসময় পুনরায় যাচাই, যাতে আপডেট দ্রুত দেখা যায়
    if ((request.headers.get('accept') || '').includes('text/html')) {
      const headers = new Headers(response.headers);
      headers.set('cache-control', 'public, max-age=0, must-revalidate');
      return new Response(response.body, { status: response.status, headers });
    }

    return response;
  },
};
