import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma.service';
// ✅ NEW IMPORT: Import the modern client class
import { GoogleGenAI } from '@google/genai'; 
import { pipeline } from '@xenova/transformers';

@Injectable()
export class RagService implements OnModuleInit {
  // ✅ NEW TYPE: Updated to use the unified GoogleGenAI class
  private ai: GoogleGenAI; 

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    const apiKey = this.configService.get<string>('GOOGLE_AI_STUDIO_KEY');
    
    if (!apiKey) {
      throw new Error('GOOGLE_AI_STUDIO_KEY is missing from .env file');
    }

    // 🔥 التعديل الجوهري: إجبار الـ SDK الموحد على استخدام مسار v1 المستقر
    this.ai = new GoogleGenAI({ 
      apiKey: apiKey,
      httpOptions: { apiVersion: 'v1' } 
    });
  }

  async onModuleInit() {
    // Ensure the pgvector extension exists — retry a few times on transient errors
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector;`);
        console.log('✅ pgvector extension ensured');
        break;
      } catch (err) {
        console.error(`Attempt ${attempt} to create pgvector extension failed:`, err?.message || err);
        if (attempt === maxAttempts) {
          console.error('Giving up creating pgvector extension after multiple attempts — continuing without it.');
        } else {
          // wait a bit before retrying (exponential backoff)
          await new Promise(res => setTimeout(res, attempt * 2000));
        }
      }
    }
  }

  /**
   * Generates embedding using the unified @google/genai SDK
   */
  /**
   * Generates embedding using the unified @google/genai SDK
   */
  /**
   * Generates embedding using the unified @google/genai SDK
   */

  

  // Local extractor / fallback embedding model (cached on the instance)
  private extractor: any = null;

  private async getExtractor() {
    if (!this.extractor) {
      // This loads the model. It downloads once and caches it locally.
      this.extractor = await pipeline('feature-extraction', 'Xenova/bge-base-en-v1.5');
    }
    return this.extractor;
  }

  private async localGenerateEmbedding(text: string): Promise<number[]> {
    console.log('Generating local embedding for text:', text);
    try {
      const extract = await this.getExtractor();

      // Generate the embedding (pooling: 'mean' and normalize are standard for BGE)
      const output = await extract(text, { pooling: 'mean', normalize: true });

      // Convert the tensor output into a standard JavaScript array
      const embedding = Array.from(output.data) as number[];

      // BGE-base outputs exactly 768 dimensions
      return embedding;
    } catch (error) {
      console.error('Error generating local embedding:', error);
      throw error;
    } finally {
      console.log('Local embedding generation attempt completed.');
    }
  }

  // Try Google GenAI first, fall back to local embedding via Xenova
  private async generateEmbedding(text: string): Promise<number[]> {
    // Attempt Google GenAI embeddings
    try {
      const response = await this.ai.models.embedContent({
        model: 'gemini-embedding-2',
        contents: text,
        config: { outputDimensionality: 768 },
      });

      const res: any = response;
      if (res.embeddings && res.embeddings.length > 0 && res.embeddings[0].values) {
        return res.embeddings[0].values;
      }
      if (res.embedding && res.embedding.values) {
        return res.embedding.values;
      }

      throw new Error('No embedding values found in Google GenAI response');
    } catch (err: any) {
      const isPermissionDenied = err && (err.status === 403 || (err?.message && err.message.includes('PERMISSION_DENIED')) || (err?.message && err.message.includes('denied')));
      if (isPermissionDenied) {
        console.warn('Google GenAI permission denied — falling back to local embedding (Xenova).');
      } else {
        console.error('Google GenAI embedding failed, falling back to local model:', err?.message || err);
      }

      // Fallback to local embedding
      try {
        const local = await this.localGenerateEmbedding(text);
        return local;
      } catch (localErr) {
        console.error('Local embedding also failed:', localErr);
        // rethrow original Google error if present, otherwise local error
        throw err || localErr;
      }
    }
  }


  // async generateEmbedding(text: string): Promise<number[]> {
  //   console.log('Generating embedding for text:', text);
  //   try {
  //     const response = await this.ai.models.embedContent({
  //       model: 'gemini-embedding-2',
  //       contents: text,
  //       // This forces the model to return exactly 768 dimensions
  //       config: {
  //           outputDimensionality: 768
  //       }
  //   });

  //     // تحويل الرد إلى any لتفادي اعتراضات الـ TypeScript والوصول للمصفوفة مباشرة
  //     const res = response as any;

  //     // الحالة الأولى: الرد يحتوي على مصفوفة embeddings (وهو التصميم الأساسي للـ SDK الموحد)
  //     if (res.embeddings && res.embeddings.length > 0 && res.embeddings[0].values) {
  //       return res.embeddings[0].values;
  //     }

  //     // الحالة الثانية: الرد يحتوي على كائن embedding مفرد
  //     if (res.embedding && res.embedding.values) {
  //       return res.embedding.values;
  //     }
      
  //     throw new Error('No embedding values found in the response layout');
  //   } catch (error) {
  //     console.error('Error generating embedding:', error);
  //     throw error;
  //   }finally{
  //     console.log('Embedding generation attempt completed.');
  //   }
  // }

  /**
   * Save knowledge with fixed position placeholder parameters
   */
  async saveKnowledge(content: string) {
    const embedding = await this.generateEmbedding(content);
    const embeddingString = `[${embedding.join(',')}]`;

    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "Knowledge" (id, content, embedding, "createdAt", "updatedAt") 
       VALUES (gen_random_uuid(), $1, $2::vector, NOW(), NOW());`,
      content,
      embeddingString,
    );
  }

  /**
   * Time-Aware Vector Search with corrected Prisma argument syntax
   */
  async searchKnowledge(question: string, similarityThreshold = 0.5): Promise<string[]> {
    const questionEmbedding = await this.generateEmbedding(question);
    const embeddingString = `[${questionEmbedding.join(',')}]`;

    const results: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT content, "createdAt",
       (1 - (embedding <=> $1::vector)) AS similarity
       FROM "Knowledge"
       WHERE (1 - (embedding <=> $1::vector)) > $2
       ORDER BY similarity DESC, "createdAt" DESC
       LIMIT 3;`,
      embeddingString,
      similarityThreshold,
    );

    if (results && results.length > 0) {
      return results.map(r => r.content);
    }

    return [];
  }

  async saveQuickResponse(keyword: string, reply: string): Promise<void> {
    // توليد الـ Embedding للكلمة المفتاحية (باستخدام نفس دالة التضمين المعتمدة لمشروعك)
    const embedding = await this.generateEmbedding(keyword); 
    const embeddingString = `[${embedding.join(',')}]`;

    // استخدام SQL خام لحفظ الـ Vector بشكل صحيح في Neon
    await this.prisma.$executeRawUnsafe(`
      INSERT INTO "quick_responses" (id, keyword, reply, embedding, "createdAt")
      VALUES (gen_random_uuid(), $1, $2, $3::vector, NOW())
      ON CONFLICT (keyword) 
      DO UPDATE SET reply = $2, embedding = $3::vector;
    `, keyword, reply, embeddingString);
  }

  // 2️⃣ دالة البحث عن أقرب رد ثابت بحد قرب صارم جداً (Threshold) لضمان عدم الخلط
  async searchQuickResponse(question: string): Promise<{ reply: string } | null> {
    const questionEmbedding = await this.generateEmbedding(question);
    const embeddingString = `[${questionEmbedding.join(',')}]`;
    console.log('🔍 Embedding for question generated:', embeddingString);
    // 🎯 هنا نضع حد قرب صارم جداً (مثلاً أقل من 0.35) لأننا نريد التقاط التحيات والأسئلة المتطابقة في المعنى فقط
    const threshold = 0.1; 

    const matches: any[] = await this.prisma.$queryRawUnsafe(`
      SELECT reply, (embedding <=> $1::vector) as distance 
      FROM "quick_responses"
      WHERE (embedding <=> $1::vector) < $2
      ORDER BY distance ASC 
      LIMIT 1;
    `, embeddingString, threshold);

    return matches.length > 0 ? { reply: matches[0].reply } : null;
  }

  /**
   * Search for services by name (case-insensitive, partial match)
   */
  async searchServices(serviceName: string): Promise<any[]> {
    try {
      const results = await this.prisma.serviceProvider.findMany({
        where: {
          service: {
            contains: serviceName,
            mode: 'insensitive',
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      return results;
    } catch (error) {
      console.error('Error searching services:', error);
      return [];
    }
  }

  /**
   * Save a new service provider record
   */
  async saveServiceProvider(data: { service: string; provider: string; phoneNumber?: string; notes?: string }) {
    try {
      // generate embedding for the service entry
      const text = `${data.service} ${data.provider} ${data.notes || ''}`;
      const embedding = await this.generateEmbedding(text);
      const embeddingString = `[${embedding.join(',')}]`;

      const results: any = await this.prisma.$queryRawUnsafe(
        `INSERT INTO "service_providers" (id, service, provider, "phoneNumber", notes, embedding, "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::vector, NOW(), NOW())
         RETURNING id, service, provider, "phoneNumber", notes, "createdAt", "updatedAt";`,
        data.service,
        data.provider,
        data.phoneNumber || '',
        data.notes || null,
        embeddingString,
      );

      return results && results[0] ? results[0] : null;
    } catch (error) {
      console.error('Error saving service provider:', error);
      throw error;
    }
  }
}
