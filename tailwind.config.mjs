/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  safelist: [
    // 設計書・要件定義書でJSで動的に生成するクラス
    'border-blue-200', 'border-purple-200', 'border-green-200', 'border-orange-200',
    'bg-blue-50', 'bg-purple-50', 'bg-green-50', 'bg-orange-50',
    'text-blue-700', 'text-purple-700', 'text-green-700', 'text-orange-700',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
