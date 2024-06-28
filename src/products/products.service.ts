import {
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Model, ObjectId, Types } from 'mongoose';
import { ProductDocument } from './schemas/product.schema';
import { CreateProductDto, UpdateProductDto } from './dto';
import { SoftDeleteModel } from 'soft-delete-plugin-mongoose';
import { BadRequestException } from '@nestjs/common';
import { MembersService } from 'src/members/members.service';
import { Attribute } from './interfaces/product.interface';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { MemberDocument } from 'src/members/schemas/member.schema';

export interface ProductModel
  extends Model<ProductDocument>,
    SoftDeleteModel<ProductDocument> {}

@Injectable()
export class ProductsService {
  constructor(
    @Inject('PRODUCT_MODEL')
    private readonly productRepository: ProductModel,
    private readonly memberService: MembersService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  private normalizeProductData(product: CreateProductDto) {
    return {
      ...product,
      name: product.name
        ?.trim()
        .toLowerCase()
        .replace(/\b\w/g, (char) => char.toUpperCase()),
      assignedEmail: product.assignedEmail
        ? product.assignedEmail.toLowerCase()
        : undefined,
    };
  }

  private getFullName(member: any): string {
    if (member && member.firstName && member.lastName) {
      return `${member.firstName} ${member.lastName}`;
    }
    return '';
  }

  private async validateSerialNumber(serialNumber: string) {
    if (!serialNumber || serialNumber.trim() === '') {
      return;
    }

    const productWithSameSerialNumber = await this.productRepository.findOne({
      serialNumber,
    });
    const memberProductWithSameSerialNumber =
      await this.memberService.findProductBySerialNumber(serialNumber);

    if (productWithSameSerialNumber || memberProductWithSameSerialNumber) {
      throw new BadRequestException('Serial Number already exists');
    }
  }

  async create(createProductDto: CreateProductDto) {
    const normalizedProduct = this.normalizeProductData(createProductDto);
    const { assignedEmail, serialNumber, ...rest } = normalizedProduct;

    if (serialNumber && serialNumber.trim() !== '') {
      await this.validateSerialNumber(serialNumber);
    }

    const createData =
      serialNumber && serialNumber.trim() !== ''
        ? { ...rest, serialNumber }
        : rest;

    if (assignedEmail) {
      const member = await this.memberService.assignProduct(
        assignedEmail,
        createData,
      );

      if (member) {
        return member.products.at(-1);
      }
    }

    return await this.productRepository.create({
      ...createData,
      assignedEmail,
    });
  }

  async bulkCreate(createProductDtos: CreateProductDto[]) {
    const session = await this.connection.startSession();
    session.startTransaction();

    try {
      const normalizedProducts = createProductDtos.map(
        this.normalizeProductData,
      );

      const productsWithSerialNumbers = normalizedProducts.filter(
        (product) => product.serialNumber,
      );
      const seenSerialNumbers = new Set<string>();
      const duplicates = new Set<string>();

      productsWithSerialNumbers.forEach((product) => {
        if (product.serialNumber) {
          if (seenSerialNumbers.has(product.serialNumber)) {
            duplicates.add(product.serialNumber);
          } else {
            seenSerialNumbers.add(product.serialNumber);
          }
        }
      });

      if (duplicates.size > 0) {
        throw new BadRequestException(`Serial Number already exists`);
      }

      for (const product of normalizedProducts) {
        const { serialNumber } = product;

        if (serialNumber && serialNumber.trim() !== '') {
          await this.validateSerialNumber(serialNumber);
        }
      }

      const createData = normalizedProducts.map((product) => {
        const { serialNumber, ...rest } = product;
        return serialNumber && serialNumber.trim() !== ''
          ? { ...rest, serialNumber }
          : rest;
      });

      const productsWithIds = createData.map((product) => {
        return {
          ...product,
          _id: new Types.ObjectId(),
        };
      });

      const productsWithoutAssignedEmail = productsWithIds.filter(
        (product) => !product.assignedEmail,
      );

      const productsWithAssignedEmail = productsWithIds.filter(
        (product) => product.assignedEmail,
      );

      const createdProducts: ProductDocument[] = [];

      const assignProductPromises = productsWithAssignedEmail.map(
        async (product) => {
          if (product.assignedEmail) {
            const member = await this.memberService.findByEmailNotThrowError(
              product.assignedEmail,
            );

            if (member) {
              const productDocument = new this.productRepository(
                product,
              ) as ProductDocument;
              productDocument.assignedMember = this.getFullName(member);
              member.products.push(productDocument);
              await member.save({ session });
              await this.productRepository
                .deleteOne({ _id: product._id })
                .session(session);
              createdProducts.push(productDocument);
            } else {
              const createdProduct = await this.productRepository.create(
                [product],
                { session },
              );
              createdProducts.push(...createdProduct);
            }
          }
        },
      );

      const insertManyPromise = this.productRepository.insertMany(
        productsWithoutAssignedEmail,
        { session },
      );

      const createdProductsWithoutAssignedEmail = await insertManyPromise;
      createdProducts.push(...createdProductsWithoutAssignedEmail);

      await Promise.all(assignProductPromises);

      await session.commitTransaction();
      session.endSession();

      return createdProducts;
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      if (error instanceof BadRequestException) {
        throw new BadRequestException(`Serial Number already exists`);
      } else {
        throw new InternalServerErrorException();
      }
    }
  }

  async tableGrouping() {
    const productsFromRepository = await this.productRepository.find({
      isDeleted: false,
    });

    const productsFromMembers =
      await this.memberService.getAllProductsWithMembers();

    const allProducts = [...productsFromRepository, ...productsFromMembers];

    const productsWithFilteredAttributes = allProducts.map((product) => {
      const {
        _id,
        category,
        name,
        attributes,
        status,
        acquisitionDate,
        assignedEmail,
        assignedMember,
        deleteAt,
        isDeleted,
        lastAssigned,
        location,
        recoverable,
        serialNumber,
      } = product;
      const filteredAttributes = attributes.filter(
        (attribute: Attribute) =>
          attribute.key !== 'color' &&
          attribute.key !== 'keyboardLanguage' &&
          attribute.key !== 'gpu',
      );

      return {
        _id,
        category,
        name,
        attributes,
        status,
        acquisitionDate,
        assignedEmail,
        assignedMember,
        deleteAt,
        isDeleted,
        lastAssigned,
        location,
        recoverable,
        serialNumber,
        filteredAttributes,
      };
    });

    const groupedProducts = productsWithFilteredAttributes.reduce(
      (acc, product) => {
        if (product.category !== 'Merchandising') {
          const key = JSON.stringify({
            category: product.category,
            attributes: product.filteredAttributes
              .sort((a, b) => a.key.localeCompare(b.key))
              .map((atr) => atr.value),
          });

          if (!acc[key]) {
            acc[key] = {
              category: product.category,

              products: [],
            };
          }

          acc[key].products.push(product);
          return acc;
        } else {
          const key = JSON.stringify({
            category: product.category,
            name: product.name,
          });

          if (!acc[key]) {
            acc[key] = {
              category: product.category,
              products: [],
            };
          }

          acc[key].products.push(product);
          return acc;
        }
      },
      {},
    );

    const result = Object.values(groupedProducts);

    // return result;
    // Ordenar los productos: primero los de categoría "Computer" y luego el resto por orden alfabético de categoría

    const sortedResult = result
      // @ts-expect-error as @ts-ignore
      .filter((group) => group.category === 'Computer')
      .concat(
        result
          // @ts-expect-error as @ts-ignore
          .filter((group) => group.category !== 'Computer')
          // @ts-expect-error as @ts-ignore
          .sort((a, b) => a.category.localeCompare(b.category)),
      );

    return sortedResult;
  }

  async findById(id: ObjectId) {
    const product = await this.productRepository.findById(id);

    if (product) {
      if (product.isDeleted) {
        throw new NotFoundException(`Product with id "${id}" not found`);
      }

      return product;
    }

    const memberProduct = await this.memberService.getProductByMembers(id);

    if (memberProduct?.product) {
      if (memberProduct?.product.isDeleted) {
        throw new NotFoundException(`Product with id "${id}" not found`);
      }

      return memberProduct.product;
    }

    throw new NotFoundException(`Product with id "${id}" not found`);
  }

  private filterMembers(
    members: MemberDocument[],
    currentEmail: string | null,
    includeNone: boolean = false,
  ) {
    const filteredMembers = members
      .filter((member) => member.email !== currentEmail && !member.$isDeleted())
      .map((member) => ({
        email: member.email,
        name: `${member.firstName} ${member.lastName}`,
        team: member.team,
      }));
    if (includeNone) {
      filteredMembers.push({
        email: 'none',
        name: 'None',
        team: undefined as Types.ObjectId | undefined,
      });
    }
    return filteredMembers;
  }

  async getProductForReassign(productId: ObjectId) {
    let product: ProductDocument | null =
      await this.productRepository.findById(productId);
    let currentMember: MemberDocument | null = null;

    if (!product) {
      const memberProduct =
        await this.memberService.getProductByMembers(productId);
      if (!memberProduct) {
        throw new NotFoundException(`Product with id "${productId}" not found`);
      }
      product = memberProduct.product as ProductDocument;
      currentMember = memberProduct.member as MemberDocument;
    } else {
      currentMember = product.assignedEmail
        ? await this.memberService.findByEmail(product.assignedEmail)
        : null;
    }

    const members = await this.memberService.findAll();

    const options = this.filterMembers(members, product?.assignedEmail || null);

    return { product, options, currentMember };
  }

  async getProductForAssign(productId: ObjectId) {
    const product = await this.productRepository.findById(productId);
    if (!product) {
      throw new NotFoundException(`Product with id "${productId}" not found`);
    }

    const members = await this.memberService.findAll();

    let options;

    if (product.assignedEmail === '') {
      options = this.filterMembers(members, null);
    } else if (product.assignedEmail !== '' && product.assignedMember === '') {
      options = this.filterMembers(members, null, true);
    }

    return { product, options };
  }

  async reassignProduct(id: ObjectId, updateProductDto: UpdateProductDto) {
    if (updateProductDto.assignedEmail === 'none') {
      updateProductDto.assignedEmail = '';
    }
    return this.update(id, updateProductDto);
  }

  private async moveToProductsCollection(
    session: any,
    product: ProductDocument,
    member: MemberDocument,
    updateProductDto: UpdateProductDto,
  ) {
    console.log('moveToProductsCollection - Start');
    console.log(`Product ID: ${product._id}`);
    console.log(`Member ID: ${member._id}`);

    if (member._id && product._id) {
      await this.memberService.deleteProductFromMember(
        member._id,
        product._id,
        session,
      );
      console.log('Product removed from current member');
    } else {
      throw new Error('Member ID or Product ID is undefined');
    }

    const newProductData = {
      _id: product._id,
      name: product.name,
      category: product.category,
      attributes: product.attributes,
      status: updateProductDto.status || product.status,
      recoverable: product.recoverable,
      assignedEmail: '',
      assignedMember: '',
      lastAssigned: product.assignedMember,
      acquisitionDate: product.acquisitionDate,
      location: updateProductDto.location || product.location,
      isDeleted: product.isDeleted,
    };

    console.log('Creating new product in products collection', newProductData);

    await this.productRepository.create([newProductData], { session });

    console.log('Product added to products collection');
    console.log('moveToProductsCollection - End');
  }

  // Nueva función: eliminar producto del miembro actual
  private async removeProductFromCurrentMember(
    session: any,
    product: ProductDocument,
  ) {
    if (product.assignedEmail && product.assignedEmail !== '') {
      const currentMember = await this.memberService.findByEmail(
        product.assignedEmail,
        session,
      );
      if (currentMember) {
        currentMember.products = currentMember.products.filter(
          (prod) => prod._id?.toString() !== product._id!.toString(),
        );
        await currentMember.save({ session });
      }
    }
  }

  private async updateProduct(
    session: any,
    product: ProductDocument,
    updateProductDto: UpdateProductDto,
    currentLocation: 'products' | 'members',
    member?: MemberDocument,
  ) {
    const normalizedUpdateProductDto =
      this.normalizeProductData(updateProductDto);

    console.log('updateProduct - Start');
    console.log(`Current Location: ${currentLocation}`);
    console.log(`Product ID: ${product._id}`);

    if (
      !normalizedUpdateProductDto.assignedEmail ||
      normalizedUpdateProductDto.assignedEmail === product.assignedEmail
    ) {
      console.log('Updating product in the same collection');
      if (currentLocation === 'products') {
        await this.productRepository.updateOne(
          { _id: product._id },
          { $set: normalizedUpdateProductDto },
          { session, runValidators: true, new: true, omitUndefined: true },
        );
        console.log('Product updated in products collection');
      } else if (currentLocation === 'members' && member) {
        const productIndex = member.products.findIndex(
          (prod) => prod._id!.toString() === product._id!.toString(),
        );
        if (productIndex !== -1) {
          Object.assign(
            member.products[productIndex],
            normalizedUpdateProductDto,
          );
          await member.save({ session });
          console.log('Product updated in members collection');
        }
      }
    } else {
      console.log('Moving product to a different collection');
      if (
        normalizedUpdateProductDto.assignedEmail &&
        normalizedUpdateProductDto.assignedEmail !== 'none'
      ) {
        const newMember = await this.memberService.findByEmail(
          normalizedUpdateProductDto.assignedEmail,
          session,
        );
        if (!newMember) {
          throw new NotFoundException(
            `Member with email "${normalizedUpdateProductDto.assignedEmail}" not found`,
          );
        }

        await this.removeProductFromCurrentMember(session, product);
        console.log('Product removed from current member');

        newMember.products.push({
          _id: product._id,
          name: product.name,
          category: product.category,
          attributes: product.attributes,
          status: normalizedUpdateProductDto.status || product.status,
          recoverable: product.recoverable,
          assignedEmail: normalizedUpdateProductDto.assignedEmail,
          assignedMember: normalizedUpdateProductDto.assignedMember,
          acquisitionDate: product.acquisitionDate,
          location: normalizedUpdateProductDto.location || product.location,
          isDeleted: product.isDeleted,
          lastAssigned: product.assignedMember,
        });
        await newMember.save({ session });

        if (currentLocation === 'products') {
          await this.productRepository
            .findByIdAndDelete(product._id)
            .session(session);
          console.log('Product deleted from products collection');
        }
      } else if (normalizedUpdateProductDto.assignedEmail === '') {
        console.log('Moving product from members to products collection');
        if (currentLocation === 'members' && member) {
          await this.moveToProductsCollection(
            session,
            product,
            member,
            normalizedUpdateProductDto,
          );
        } else {
          await this.productRepository.updateOne(
            { _id: product._id },
            {
              $set: {
                ...normalizedUpdateProductDto,
                assignedEmail: '',
                assignedMember: '',
                lastAssigned: product.assignedMember,
              },
            },
            { session, runValidators: true, new: true, omitUndefined: true },
          );
          console.log(
            'Product updated in products collection with unassigned status',
          );
        }
      }
    }
    console.log('updateProduct - End');
  }

  async update(id: ObjectId, updateProductDto: UpdateProductDto) {
    const session = await this.connection.startSession();
    session.startTransaction();

    try {
      const product = await this.productRepository
        .findById(id)
        .session(session);
      if (product) {
        await this.updateProduct(
          session,
          product,
          updateProductDto,
          'products',
        );
      } else {
        const memberProduct = await this.memberService.getProductByMembers(
          id,
          session,
        );
        if (memberProduct?.product) {
          await this.updateProduct(
            session,
            memberProduct.product as ProductDocument,
            updateProductDto,
            'members',
            memberProduct.member,
          );
        } else {
          throw new NotFoundException(`Product with id "${id}" not found`);
        }
      }

      await session.commitTransaction();
      session.endSession();

      return { message: `Product with id "${id}" updated successfully` };
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  }

  async softDelete(id: ObjectId) {
    const session = await this.connection.startSession();
    session.startTransaction();

    try {
      const product = await this.productRepository
        .findById(id)
        .session(session);

      if (product) {
        product.status = 'Deprecated';
        await product.save();
        await this.productRepository.softDelete({ _id: id }, { session });

        await session.commitTransaction();
        session.endSession();

        return {
          message: `Product with id ${id} has been soft deleted`,
        };
      }

      const memberProduct = await this.memberService.getProductByMembers(id);

      if (memberProduct && memberProduct.product) {
        const {
          _id,
          name,
          attributes,
          category,
          assignedEmail,
          assignedMember,
          acquisitionDate,
          deleteAt,
          isDeleted,
          location,
          recoverable,
          serialNumber,
        } = memberProduct.product;

        await this.productRepository.create(
          [
            {
              _id,
              name,
              attributes,
              category,
              assignedEmail,
              assignedMember,
              acquisitionDate,
              deleteAt,
              isDeleted,
              location,
              recoverable,
              serialNumber,
              lastAssigned: memberProduct.member.email,
              status: 'Deprecated',
            },
          ],
          { session },
        );

        await this.productRepository.softDelete({ _id: id }, { session });

        const memberId = memberProduct.member._id;
        await this.memberService.deleteProductFromMember(memberId, id);

        await session.commitTransaction();
        session.endSession();

        return {
          message: `Product with id ${id} has been soft deleted`,
        };
      }
      throw new NotFoundException(`Product with id "${id}" not found`);
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  }
}
