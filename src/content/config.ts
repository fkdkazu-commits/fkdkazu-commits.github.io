import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    keyword: z.string(),
    tags: z.array(z.string()).default([]),
    ogImage: z.string().optional(),
    canonicalUrl: z.string().optional(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
